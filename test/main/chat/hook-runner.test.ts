import fs from 'node:fs'
import path from 'node:path'
import { runAgent, MAIN_AGENT_MAX_STEPS, type RunResult } from '../../../src/main/agent/loop'
import { SUB_AGENT_MAX_STEPS } from '../../../src/main/agent/task'
import { withApproval, type ApprovalDeps } from '../../../src/main/chat/approval'
import { withHooks } from '../../../src/main/chat/hook'
import { createApprovalGate, type ApprovalGate } from '../../../src/main/chat/approvals'
import { createHookSet, type HookRun } from '../../../src/main/hooks/set'
import type { HookSetDeps } from '../../../src/main/hooks/set'
import type { HookPayload } from '../../../src/main/hooks/contract'
import type { HookBoundary } from '../../../src/main/hooks/boundary'
import { hooksLogPath, recentHooks } from '../../../src/main/hooks/log'
import { DEFAULT_HOOK_TIMEOUT_MS } from '../../../src/main/hooks/parser'
import type { ChatCompletionMessage, StreamChatParams } from '../../../src/main/chat/llm'
import type { ContextBudget } from '../../../src/main/agent/context'
import type { HookEvent, HookMeta, HookReply } from '../../../src/main/hooks/types'
import type {
  ApprovalOutcome,
  ApprovalRequest,
  ChatStreamEvent,
  RunScope,
  ToolCallRecord
} from '../../../src/main/chat/dto'
import type { PermissionMode } from '../../../src/main/store/types'
import {
  createToolRunner,
  type ToolContext,
  type ToolDefinition,
  type ToolRunner
} from '../../../src/main/tools/registry'
import type { ExecBoundary } from '../../../src/main/sandbox'
import {
  makeCall,
  makeEmit,
  makeModel,
  makeRunner,
  makeStore,
  makeTool,
  rootScope,
  subScope,
  type CollectedRun,
  type FakeModel,
  type FakeStore,
  type ModelStep,
  type TestTool
} from '../../helpers/agent'
import { makeTempDir, removeTempDir, writeFiles } from '../../helpers/temp'

/**
 * 钩子接进一次真实 run 之后的行为。
 *
 * 派发规则在 `test/main/hooks/set.test.ts`、管道在 `test/main/hooks/runner.test.ts`,
 * 这一份只管**接线**:`withHooks` 与 `withApproval` 的先后、否决的收场、`ToolContext` 里的
 * 步号与边界有没有一路走到 payload,以及四个 run/请求时机在循环里的落位 ——
 * 说明有没有真的进下一次请求、`afterAgent` 是不是每条出口各一次且早于终局事件、
 * `beforeAgent` 否决时库里是不是真的一行都没有。这几条都只在串起来的时候才露出破绽 ——
 * 尤其「钩子套在闸门外面」与「说明攒了却没人取」这两条,换个顺序或漏掉一次调用,
 * 除这里以外没有别处会变红。
 *
 * 大部分用例用**假的执行体**(`HookSetDeps.run`),所以不起进程、结果确定;
 * 最后一组用真的 `runHook` 跑一个真 node 进程,钉的是「接线拼起来之后整条链真的通」。
 */

const DIR = path.join(path.sep, 'hooks', 'demo')
const NODE = process.execPath
/** loop 把每条钩子说明拼成一条 user 消息时加的那个前缀(见 `agent/loop.ts`) */
const NOTE_PREFIX = '[系统说明] '

/**
 * 第 n 次请求里那几条说明的正文。
 *
 * 断「说明真的进了那一步要发出去的请求」而不是「还躺在缓冲区里」—— 后者是阶段 4 的临时状态,
 * 而接线错了最容易出现的恰恰是「攒了却没人取」。
 */
function noteLines(request: StreamChatParams | undefined): string[] {
  if (!request) return []
  return request.messages
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .filter((text) => text.startsWith(NOTE_PREFIX))
    .map((text) => text.slice(NOTE_PREFIX.length))
}

/** 第 n 次请求里那几条说明在数组中的下标,用来钉「说明排在目标锚定之前」 */
function noteIndexes(request: StreamChatParams | undefined): number[] {
  if (!request) return []
  const indexes: number[] = []
  request.messages.forEach((message, i) => {
    const text = typeof message.content === 'string' ? message.content : ''
    if (text.startsWith(NOTE_PREFIX)) indexes.push(i)
  })
  return indexes
}

/** 名字必须是审批面内的真名,判定才走真实分支;执行体全是假的 */
function makeKit(): Record<string, TestTool> {
  return {
    run_command: makeTool('命令已执行'),
    read_file: makeTool('文件内容'),
    write_file: makeTool('已写入'),
    get_current_time: makeTool('2026-10-17 10:00:00')
  }
}

function meta(name: string, event: HookEvent, fields: Partial<HookMeta> = {}): HookMeta {
  return {
    name,
    description: `${name} 的说明`,
    event,
    command: 'node',
    args: [],
    matcher: [],
    sandboxed: false,
    timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    once: false,
    doc: '',
    dir: DIR,
    enabled: true,
    ...fields
  }
}

function reply(fields: Partial<HookReply> = {}): HookReply {
  return {
    block: false,
    reason: '',
    note: '',
    rewrite: null,
    log: '',
    ignored: [],
    problem: '',
    exitCode: 0,
    out: '',
    ...fields
  }
}

/** 一份「边界装着」的快照:`execFor` 的 confined 那一支,钩子那一侧只翻结论 */
const EXEC: ExecBoundary = {
  state: 'confined',
  engine: 'seatbelt',
  allowNetwork: true,
  launch: { file: '/usr/bin/sandbox-exec', args: ['-p', '(version 1)'], env: { PATH: '/usr/bin' } }
}

interface Options {
  mode?: PermissionMode
  workspace?: string
  jail?: ToolContext['jail']
  hooks?: HookMeta[]
  /** 按钩子名给回执;没写的按「没有结论」处理 */
  replies?: Record<string, HookReply>
  /** 传了就绕过假执行体 —— 最后一组用真的 `runHook` */
  realRun?: boolean
  /** 让模型调用自己抛:那条出口的 `afterAgent` 只能靠它验 */
  failStream?: boolean
  scope?: RunScope
  request?: string
  /** 传了就用小预算:钩子改写之后那一次重裁只有额度紧时才留下可见的痕迹 */
  budget?: ContextBudget
  /**
   * 给父级工具池加一条 `task`(子 Agent 的测试替身)。
   *
   * 拿到的那一份 `shared` 是父级**同一份**声明快照派生出来的 `hooksForSub` 与同一个 gate、
   * 同一条事件流、同一个中止信号 —— 换成测试自己新起一个 `createHookSet`,这组用例验的
   * 就只是「钩子能在子 run 里跑」,而不是「父子共享那一份快照」那条真正的决定。
   */
  subTask?: (shared: SubShared) => ToolDefinition
}

/** 子 run 要从父级继承的那几件:与 `SpawnerContext` 里的 `hooks` / `approval` / `emit` 一一对应 */
interface SubShared {
  hooksForSub: (scope: RunScope, jail: ToolContext['jail'], request: string) => HookRun
  workspace: string
  gate: ApprovalGate
  emit: (event: ChatStreamEvent) => void
  signal: AbortSignal
}

interface Harness {
  controller: AbortController
  model: FakeModel
  store: FakeStore
  collected: CollectedRun
  gate: ApprovalGate
  kit: Record<string, TestTool>
  notified: ApprovalRequest[]
  runner: ToolRunner
  inner: ToolRunner
  /** 事件与钩子触发按实际先后混在一条队列里,装饰器的顺序全靠它断言 */
  order: string[]
  fired: Array<{ hook: string; payload: HookPayload; boundary: HookBoundary }>
  /** 子 run 的事件与父级进同一条流:`withApproval` 的 deps 要它,而卡片发没发也在这里看 */
  emit: (event: ChatStreamEvent) => void
  /** 父级那次 run 的目录:子 run 整套继承,与 `SpawnerContext.workspace` 同一条线 */
  workspace: string
  /**
   * 与 `service.ts` 里 `SpawnerContext.hooks` 那一个闭包同一条形状:声明快照、目录、
   * 沙箱设置、中止信号与子那侧的步数上限都握在外面,调用方只给属于子 run 的那三件事实。
   */
  hooksForSub: (scope: RunScope, jail: ToolContext['jail'], request: string) => HookRun
  running: Promise<RunResult>
}

function startRun(script: ModelStep[], options: Options = {}): Harness {
  const controller = new AbortController()
  const gate = createApprovalGate()
  const scope = options.scope ?? rootScope()
  const workspace = options.workspace ?? '/proj'
  const kit = makeKit()
  const { emit, collected } = makeEmit()
  const store = makeStore()
  const model = makeModel(script)
  const notified: ApprovalRequest[] = []
  const order: string[] = []
  const fired: Harness['fired'] = []
  const track = (event: Parameters<typeof emit>[0]): void => {
    order.push(event.type)
    emit(event)
  }

  const deps: ApprovalDeps = {
    modeOf: () => options.mode ?? 'ask',
    lists: { allow: [], deny: [] },
    workspace,
    jail: options.jail,
    scope,
    signal: controller.signal,
    gate,
    runAllow: new Set<string>(),
    mcpToolNames: new Set<string>(),
    emit: track,
    notify: (request) => {
      notified.push(request)
    }
  }

  const setDeps: HookSetDeps = options.realRun
    ? {}
    : {
        run: async (hook, payload, runOptions) => {
          // 混进同一条队列才能断出「钩子跑在闸门之前」—— 这是本份测试唯一钉住的那件事
          order.push(`hook:${hook.name}`)
          fired.push({ hook: hook.name, payload, boundary: runOptions.boundary })
          // 与 `runner.ts` 同一条契约:跳过那一支不起进程也不落处置,
          // 而 `apply` 只在回执有结论时被调用
          if (runOptions.boundary.mode === 'skip') {
            return reply({ problem: runOptions.boundary.why, exitCode: null })
          }
          const out = options.replies?.[hook.name] ?? reply({ problem: '没有结论', exitCode: null })
          if (out.problem === '') runOptions.apply(out)
          return out
        }
      }

  // 与 `service.ts` 同一对:声明快照只拍一次,父子各自 `forRun` 出属于自己的那半份状态
  const hookSet = createHookSet(options.hooks ?? [], setDeps)

  const run = hookSet.forRun({
    scope,
    workspace,
    jail: options.jail,
    // 与 `startRun` 同一条纪律:jail 与沙箱设置来自同一份快照
    sandbox: undefined,
    signal: controller.signal,
    request: options.request ?? '把这个分支推上去',
    maxSteps: MAIN_AGENT_MAX_STEPS
  })
  // 握着「父级已经拍好、子只需照抄」的那几件,调用方只给属于子的那三件事实 ——
  // 与 `SpawnerContext.hooks` 那一个闭包同一条形状
  const hooksForSub = (
    subScopeValue: RunScope,
    subJail: ToolContext['jail'],
    subRequest: string
  ): HookRun =>
    hookSet.forRun({
      scope: subScopeValue,
      workspace,
      jail: subJail,
      sandbox: undefined,
      signal: controller.signal,
      request: subRequest,
      maxSteps: SUB_AGENT_MAX_STEPS
    })
  const shared: SubShared = { hooksForSub, workspace, gate, emit: track, signal: controller.signal }
  const baseRunner = makeRunner(kit)
  // `task` 与其余工具进同一个 runner:父级那次调用照旧过 `withApproval` 与 `withHooks`
  const inner = options.subTask
    ? createToolRunner([...baseRunner.definitions, options.subTask(shared)])
    : baseRunner

  const runner = withHooks(withApproval(inner, deps), run.toolDeps)
  // 与 `chat/service.ts` 同一条接线:两层装饰器用 `toolDeps`,循环用 `runHooks`,两者同一次 `forRun`
  const running = runAgent({
    scope,
    baseUrl: 'https://model.test/v1',
    model: 'test-model',
    providerId: 'provider-1',
    signal: controller.signal,
    history: [{ role: 'user', content: options.request ?? '把这个分支推上去' }],
    runner,
    workspace,
    jail: options.jail,
    budget: options.budget,
    maxSteps: MAIN_AGENT_MAX_STEPS,
    store,
    emit: track,
    hooks: run.runHooks,
    stream: options.failStream
      ? async () => {
          throw new Error('端点把请求拒了')
        }
      : model.stream
  })
  return {
    controller,
    model,
    store,
    collected,
    gate,
    kit,
    notified,
    runner,
    inner,
    order,
    fired,
    emit: track,
    workspace,
    hooksForSub,
    running
  }
}

function call(name: string, args: Record<string, unknown>, id: string): ToolCallRecord {
  return makeCall(name, JSON.stringify(args), id)
}

function approval(h: Harness, index: number): ApprovalRequest {
  const event = h.collected.of('tool_approval')[index]
  if (!event) throw new Error(`第 ${index + 1} 条审批没有弹出来`)
  return event.request
}

async function waitApprovals(h: Harness, n: number): Promise<void> {
  for (let i = 0; i < 50 && h.collected.of('tool_approval').length < n; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  if (h.collected.of('tool_approval').length < n) {
    throw new Error(`只弹出了 ${h.collected.of('tool_approval').length} 条审批`)
  }
}

function decide(h: Harness, index: number, outcome: ApprovalOutcome): void {
  if (!h.gate.decide(approval(h, index).approvalId, outcome)) {
    throw new Error(`第 ${index + 1} 条审批已经不等了`)
  }
}

describe('装饰器的先后:政策层在人之前', () => {
  it('钩子拦下一次 run_command 时一次审批都不发:卡片不该承诺一件注定失败的事', async () => {
    const h = startRun(
      [{ toolCalls: [call('run_command', { command: 'git push --force' }, 'c-1')] }],
      {
        mode: 'ask',
        hooks: [meta('guard', 'beforeToolCall')],
        replies: { guard: reply({ block: true, reason: '这台机器上禁止强推' }) }
      }
    )
    const result = await h.running

    expect(h.collected.of('tool_approval')).toHaveLength(0)
    expect(h.notified).toHaveLength(0)
    expect(h.kit.run_command.executed).toHaveLength(0)
    // 否决不是中止,也不是失败:那一轮照常收尾
    expect(result.aborted).toBe(false)
  })

  it('钩子先跑、闸门后跑:同一次调用的顺序是 tool_call → 钩子 → tool_approval', async () => {
    const h = startRun([{ toolCalls: [call('run_command', { command: 'ls' }, 'c-1')] }], {
      mode: 'ask',
      hooks: [meta('guard', 'beforeToolCall')],
      replies: { guard: reply({ note: '这条命令只读' }) }
    })
    await waitApprovals(h, 1)
    expect(h.fired).toHaveLength(1)
    // 把两层换个顺序,只有这里会红
    const approvalIndex = h.order.indexOf('tool_approval')
    expect(h.order.indexOf('tool_call')).toBeLessThan(h.order.indexOf('hook:guard'))
    expect(h.order.indexOf('hook:guard')).toBeLessThan(approvalIndex)
    decide(h, 0, 'allow')
    await h.running
    expect(h.kit.run_command.executed).toHaveLength(1)
    expect(h.collected.of('tool_approval')).toHaveLength(1)
  })

  it('definitions 与最里层是同一份引用:两层装饰器都不能改发给模型的工具表', () => {
    const h = startRun([], { hooks: [meta('guard', 'beforeToolCall')] })
    expect(h.runner.definitions).toBe(h.inner.definitions)
    expect(h.runner.toChatCompletionTools()).toEqual(h.inner.toChatCompletionTools())
  })
})

describe('否决的收场', () => {
  it('被钩子拦下的调用只落一条 tool 行:不留孤儿 tool_calls,模型读到的是那句否决', async () => {
    const h = startRun(
      [
        { toolCalls: [call('run_command', { command: 'rm -rf /tmp/scratch' }, 'c-1')] },
        { content: '那我不删了' }
      ],
      {
        mode: 'full',
        hooks: [meta('guard', 'beforeToolCall')],
        replies: { guard: reply({ block: true, reason: '这条命令删掉了工作空间外的东西' }) }
      }
    )
    const result = await h.running

    // loop 的收尾补行靠 executed 判重:这里必须恰好一条
    expect(h.store.toolRows.map((r) => r.toolCallId)).toEqual(['c-1'])
    expect(h.store.toolRows[0].content).toBe('[被钩子 guard 拦下:这条命令删掉了工作空间外的东西]')
    expect(h.collected.of('tool_result')[0].ok).toBe(false)
    expect(result.finalContent).toContain('那我不删了')
    const toolMessage = h.model.requests[1].messages.find((m) => m.role === 'tool')
    expect(toolMessage?.content).toContain('被钩子 guard 拦下')
  })

  it('否决那句不含「请改用 / 务必」这类祈使:模型会把祈使当本轮待办去执行', async () => {
    const h = startRun([{ toolCalls: [call('run_command', { command: 'ls' }, 'c-1')] }], {
      hooks: [meta('guard', 'beforeToolCall')],
      replies: { guard: reply({ block: true, reason: '这个目录是只读的' }) }
    })
    await h.running
    expect(h.store.toolRows[0].content).not.toMatch(/请|务必|记得|应该/)
  })

  it('同参数的第二次命中本轮去重:钩子只为那一次调用跑一遍', async () => {
    const h = startRun(
      [
        {
          toolCalls: [
            call('run_command', { command: 'ls' }, 'c-1'),
            call('run_command', { command: 'ls' }, 'c-2')
          ]
        }
      ],
      {
        hooks: [meta('guard', 'beforeToolCall')],
        replies: { guard: reply({ block: true, reason: '这台机器上不许跑命令' }) }
      }
    )
    await h.running

    // loop 的缓存先于 runner.execute,所以第二次根本走不到装饰器:一次触发、一次否决
    expect(h.fired).toHaveLength(1)
    expect(h.collected.of('tool_approval')).toHaveLength(0)
    const results = h.collected.of('tool_result')
    expect(results.map((e) => e.reused)).toEqual([false, true])
    expect(results[1].result).toBe(results[0].result)
    expect(h.store.toolRows.map((r) => r.toolCallId)).toEqual(['c-1', 'c-2'])
  })

  it('一次坏掉的钩子不拦下任何东西:回执没有结论时那次调用照旧执行', async () => {
    const h = startRun([{ toolCalls: [call('run_command', { command: 'ls' }, 'c-1')] }], {
      mode: 'full',
      hooks: [meta('broken', 'beforeToolCall')]
      // 不给 replies:假执行体按「没有结论」回,而那条路必须放行
    })
    await h.running
    expect(h.fired).toHaveLength(1)
    expect(h.kit.run_command.executed).toHaveLength(1)
    expect(h.collected.of('tool_result')[0].ok).toBe(true)
  })
})

describe('事后事件看到真实的结论', () => {
  it('afterToolCall 收到内层工具真的给出的那份结果与耗时,说明攒进本步的缓冲区', async () => {
    const h = startRun([{ toolCalls: [call('run_command', { command: 'ls' }, 'c-1')] }], {
      mode: 'full',
      hooks: [meta('watch', 'afterToolCall')],
      replies: { watch: reply({ note: '这条命令输出了三个文件' }) }
    })
    await h.running

    expect(h.fired[0].payload.data).toMatchObject({ ok: true, result: '命令已执行' })
    expect(typeof h.fired[0].payload.data.durationMs).toBe('number')
    // 那一步之后模型又问了一次,而说明就贴在那次请求里(第 2 次请求 = 第 2 步)
    expect(noteLines(h.model.requests[1])).toEqual(['这条命令输出了三个文件'])
  })

  it('未知工具的拒绝也进事后钩子:审计要盯住失败的那一次而不是只盯成功', async () => {
    const h = startRun([{ toolCalls: [makeCall('delete_whole_disk', '{}', 'c-1')] }], {
      mode: 'full',
      hooks: [meta('watch', 'afterToolCall')],
      replies: { watch: reply({ note: '有一次调用找不到工具' }) }
    })
    await h.running

    expect(h.fired[0].payload.data.ok).toBe(false)
    expect(h.fired[0].payload.data.result as string).toContain('未知工具')
    // 拒绝不是中止:那一轮照常收尾,tool 行也照常只有一条
    expect(h.store.toolRows.map((r) => r.toolCallId)).toEqual(['c-1'])
  })

  it('事后钩子没有否决通道:那次调用已经真的发生过了', async () => {
    const h = startRun([{ toolCalls: [call('run_command', { command: 'ls' }, 'c-1')] }], {
      mode: 'full',
      hooks: [meta('watch', 'afterToolCall')],
      // `readReply` 会把 block 归一成 false(那个键在这个事件上不读),所以递到这里的回执就是这样
      replies: { watch: reply({ note: '跑完了', ignored: ['block'] }) }
    })
    await h.running
    expect(h.kit.run_command.executed).toHaveLength(1)
    expect(h.collected.of('tool_result')[0].ok).toBe(true)
    expect(noteLines(h.model.requests[1])).toEqual(['跑完了'])
  })
})

describe('ToolContext 一路到 payload', () => {
  it('步号由循环给出:第 2 步的那次调用在 payload 里写的是 2', async () => {
    const h = startRun(
      [
        { toolCalls: [call('run_command', { command: 'ls' }, 'c-1')] },
        { toolCalls: [call('read_file', { path: 'a.md' }, 'c-2')] },
        { content: '好了' }
      ],
      {
        mode: 'full',
        hooks: [meta('guard', 'beforeToolCall')],
        replies: { guard: reply({ note: '记下了' }) }
      }
    )
    await h.running
    expect(h.fired.map((one) => one.payload.run.step)).toEqual([1, 2])
  })

  it('参数不是合法 JSON 时钩子照样被看见、审批照样不问:两层装饰器读同一份解析', async () => {
    const h = startRun([{ toolCalls: [makeCall('run_command', '不是 JSON', 'c-1')] }], {
      mode: 'ask',
      hooks: [meta('guard', 'beforeToolCall')],
      replies: { guard: reply({ note: '有一条调用的参数坏了' }) }
    })
    await h.running

    expect(h.fired).toHaveLength(1)
    expect(h.fired[0].payload.data.args).toBeNull()
    expect((h.fired[0].payload.data.call as { arguments: string }).arguments).toBe('不是 JSON')
    expect(h.collected.of('tool_approval')).toHaveLength(0)
    // 那句报错由内层 runner 给,它手里才有 schema
    expect(h.collected.of('tool_result')[0].result).toContain('不是合法的 JSON')
  })

  it('sandboxed 钩子看到的边界就是这次 run 的快照:confined,且启动器是同一个对象', async () => {
    const jail = { root: '/proj', exec: EXEC }
    const h = startRun([{ toolCalls: [call('run_command', { command: 'ls' }, 'c-1')] }], {
      mode: 'full',
      workspace: '/proj',
      jail,
      hooks: [meta('guard', 'beforeToolCall', { sandboxed: true })],
      replies: { guard: reply({ note: '记下了' }) }
    })
    await h.running

    expect(h.fired[0].payload.boundary).toBe('confined')
    expect(h.fired[0].boundary).toMatchObject({ mode: 'run', why: '受限' })
    expect(h.fired[0].boundary).toHaveProperty('launch', jail.exec.launch)
  })

  it('声明 sandboxed 而这条会话没选工作空间:跳过而不是不受限地跑,那次调用照常执行', async () => {
    const h = startRun([{ toolCalls: [call('run_command', { command: 'ls' }, 'c-1')] }], {
      mode: 'full',
      workspace: '',
      hooks: [meta('guard', 'beforeToolCall', { sandboxed: true })],
      replies: { guard: reply({ block: true, reason: '不该跑' }) }
    })
    await h.running

    expect(h.fired[0].boundary).toMatchObject({ mode: 'skip' })
    expect(h.fired[0].payload.boundary).toBe('none')
    // 没跑 = 没有否决:方向是宁可不跑,而不是把这次调用团住,也不是不受限地跑一遍
    expect(h.kit.run_command.executed).toHaveLength(1)
    expect(h.collected.of('tool_result')[0].ok).toBe(true)
  })

  it('本轮要回应的那句话随快照固定,每个事件都带:钩子据此判断该不该开口', async () => {
    const h = startRun([{ toolCalls: [call('run_command', { command: 'ls' }, 'c-1')] }], {
      mode: 'full',
      request: '把 README 的第一段改短一点',
      hooks: [meta('guard', 'beforeToolCall')],
      replies: { guard: reply({ note: '记下了' }) }
    })
    await h.running
    expect(h.fired[0].payload.request).toBe('把 README 的第一段改短一点')
    expect(h.fired[0].payload.run).toMatchObject({
      conversationId: 'conv-1',
      runId: 'run-1',
      agent: '',
      depth: 0,
      maxSteps: MAIN_AGENT_MAX_STEPS
    })
  })
})

describe('真的钩子进程接在真实 run 上', () => {
  let dir = ''

  beforeEach(() => {
    dir = makeTempDir()
    process.env.CYBERTIGER_HOOKS_LOG = path.join(dir, 'hooks.jsonl')
  })

  afterEach(() => {
    delete process.env.CYBERTIGER_HOOKS_LOG
    removeTempDir(dir)
  })

  it('钩子从 stdin 读到的就是模型写下的那条命令,否决一路落到 tool 行与日志', async () => {
    writeFiles(dir, {
      'hook.cjs': `const p = JSON.parse(require('fs').readFileSync(0, 'utf8'))
const command = (p.data.args || {}).command || ''
process.stdout.write(JSON.stringify(
  command.includes('rm -rf')
    ? { block: true, reason: '这条命令里有 rm -rf:' + p.run.agent + '/' + String(p.run.step) }
    : { note: '看过:' + command }
))`
    })
    const hook: HookMeta = {
      ...meta('probe', 'beforeToolCall'),
      command: NODE,
      args: ['hook.cjs'],
      dir
    }
    const h = startRun(
      [
        { toolCalls: [call('run_command', { command: 'rm -rf /tmp/scratch' }, 'c-1')] },
        { content: '换一个办法' }
      ],
      { mode: 'full', hooks: [hook], realRun: true }
    )
    await h.running

    expect(h.kit.run_command.executed).toHaveLength(0)
    expect(h.store.toolRows[0].content).toContain('这条命令里有 rm -rf')
    // 日志那一行是这一次触发唯一的可观测面:没有新的事件类型进 ChatStreamEvent
    const rows = recentHooks()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      hook: 'probe',
      event: 'beforeToolCall',
      decision: 'blocked',
      conversationId: 'conv-1',
      runId: 'run-1',
      step: 1
    })
    expect(h.collected.of('tool_approval')).toHaveLength(0)
  })

  it('放行那一支照样跑真进程,而说明落进本步缓冲区、日志记一行 adopted', async () => {
    writeFiles(dir, {
      'hook.cjs': `const p = JSON.parse(require('fs').readFileSync(0, 'utf8'))
process.stdout.write(JSON.stringify({ note: '目录是 ' + p.dir }))`
    })
    const hook: HookMeta = {
      ...meta('note-taker', 'beforeToolCall'),
      command: NODE,
      args: ['hook.cjs'],
      dir
    }
    const h = startRun([{ toolCalls: [call('run_command', { command: 'ls' }, 'c-1')] }], {
      mode: 'full',
      hooks: [hook],
      realRun: true
    })
    await h.running

    expect(h.kit.run_command.executed).toHaveLength(1)
    expect(noteLines(h.model.requests[1])).toEqual([`目录是 ${dir}`])
    const rows = recentHooks()
    expect(rows[0]).toMatchObject({ hook: 'note-taker', decision: 'adopted' })
    // 退出码 0 不留 `exit` 那一格:读那行的人要一眼分清「它按约定回了话」与「它崩了」
    expect(rows[0].exit).toBeUndefined()
    expect(rows[0].note).toBe(`目录是 ${dir}`)
    // 日志路径确实走的是那条环境变量接缝,没写到用户的 userData 里
    expect(hooksLogPath()).toBe(path.join(dir, 'hooks.jsonl'))
  })

  it('钩子脚本自己崩了只留一行 failed,那次调用照常执行:fail-open 在真实链路上成立', async () => {
    writeFiles(dir, { 'hook.cjs': 'throw new Error("脚本自己坏了")' })
    const hook: HookMeta = {
      ...meta('broken', 'beforeToolCall'),
      command: NODE,
      args: ['hook.cjs'],
      dir
    }
    const h = startRun([{ toolCalls: [call('run_command', { command: 'ls' }, 'c-1')] }], {
      mode: 'full',
      hooks: [hook],
      realRun: true
    })
    const result = await h.running

    expect(result.aborted).toBe(false)
    expect(h.kit.run_command.executed).toHaveLength(1)
    expect(h.collected.of('tool_result')[0].ok).toBe(true)
    const rows = recentHooks()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ hook: 'broken', decision: 'failed', failure: 'bad-output' })
  })

  it('run 中止时钩子进程被同一个 signal 收掉:那一轮不会吊死在一次触发上', async () => {
    writeFiles(dir, {
      'hook.cjs': `const fs = require('fs')
fs.writeFileSync(process.argv[2] + '/marker', 'started')
setTimeout(() => process.stdout.write('{}'), 60000)`
    })
    const hook: HookMeta = {
      ...meta('slow', 'beforeToolCall'),
      command: NODE,
      args: ['hook.cjs', dir],
      dir,
      timeoutMs: 60000
    }
    const h = startRun([{ toolCalls: [call('run_command', { command: 'ls' }, 'c-1')] }], {
      mode: 'full',
      hooks: [hook],
      realRun: true
    })
    // 等钩子真的起了进程(marker 落盘),再按停止
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, 'marker')); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(fs.existsSync(path.join(dir, 'marker'))).toBe(true)
    h.controller.abort()
    const result = await h.running

    // 这一条要钉的是「await 一定有结论」:60 秒的超时不能把整轮按在那里
    expect(result.aborted).toBe(true)
    const rows = recentHooks()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ hook: 'slow', decision: 'failed', failure: 'aborted' })
    // 已落库的调用恰好一条收尾行,中止后没有第二份
    expect(h.store.toolRows.map((r) => r.toolCallId)).toEqual(['c-1'])
    // 会话没被这次等待吊住:审批那侧同一条纪律
    expect(h.gate.list()).toEqual([])
  })

  it('钩子把整份消息原样回传时发出去的那一份逐字节不变:幂等 —— 回传原样不该自己把前缀缓存打掉', async () => {
    writeFiles(dir, {
      'hook.cjs': `const fs = require('fs')
const p = JSON.parse(require('fs').readFileSync(0, 'utf8'))
fs.writeFileSync(p.dir + '/given-' + p.run.step + '.json', JSON.stringify(p.data.messages))
process.stdout.write(JSON.stringify({ messages: p.data.messages }))`
    })
    const hook: HookMeta = {
      ...meta('echo', 'beforeRequest'),
      command: NODE,
      args: ['hook.cjs'],
      dir
    }
    const h = startRun(
      [{ toolCalls: [call('run_command', { command: 'ls' }, 'c-1')] }, { content: '好了' }],
      { mode: 'full', hooks: [hook], realRun: true }
    )
    await h.running

    // 钩子从 stdin 读到的那一份(经一轮 JSON 往返)与端点收到的那一份逐条相同:
    // 不截、不重排、`tool_calls` 与 `tool_call_id` 原样穿过
    const givenFile = path.join(dir, 'given-2.json')
    expect(fs.existsSync(givenFile)).toBe(true)
    const given = JSON.parse(fs.readFileSync(givenFile, 'utf8')) as ChatCompletionMessage[]
    expect(given).toEqual(h.model.requests[1].messages)
    // 那份消息里带着第 1 步的真实结果,而不是被谁摘过的样子
    expect(h.model.requests[1].messages.map((one) => one.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user'
    ])
    const rows = recentHooks()
    expect(rows).toHaveLength(2)
    // `recentHooks` 是「最近在前」:第 0 行就是第 2 步那一次触发
    expect(rows[0]).toMatchObject({
      hook: 'echo',
      event: 'beforeRequest',
      decision: 'adopted',
      rewritten: true,
      msgCount: h.model.requests[1].messages.length
    })
    // 日志里不出现正文:钉住「不把会话原文抄进 JSONL」
    expect(JSON.stringify(rows[0])).not.toContain('把这个分支推上去')
  })
})

describe('run 级事件接进循环', () => {
  it('beforeAgent 否决时库里一行都没有:否决发生在任何一步之前,所以结构上产不出孤儿', async () => {
    const h = startRun([{ content: '不该走到这里' }], {
      hooks: [meta('gate', 'beforeAgent')],
      replies: { gate: reply({ block: true, reason: '这台机器上不跑部署' }) }
    })
    const result = await h.running

    expect(result.error).toBe('[被钩子 gate 拦下:这台机器上不跑部署]')
    expect(result.aborted).toBe(false)
    // 一步都没跑:没有 assistant 行,也没有任何流式事件,只有那一条 error
    expect(h.store.steps.size).toBe(0)
    expect(h.model.requests).toHaveLength(0)
    expect(h.collected.events.map((e) => e.type)).toEqual(['error'])
    // 会话仍被 touch:这一轮在列表里要有它的位置,用户看到的是一句否决而不是凭空消失
    expect(h.store.touched).toEqual(['conv-1'])
  })

  it('beforeAgent 否决时 afterAgent 不触发:那一轮根本没开始,报「已完成」是谎', async () => {
    const h = startRun([{ content: '不该走到这里' }], {
      hooks: [meta('gate', 'beforeAgent'), meta('done', 'afterAgent')],
      replies: {
        gate: reply({ block: true, reason: '这台机器上不跑部署' }),
        done: reply({ note: '不该被跑' })
      }
    })
    await h.running
    expect(h.fired.map((one) => one.hook)).toEqual(['gate'])
    expect(h.collected.events.map((e) => e.type)).not.toContain('done')
  })

  it('beforeAgent 的说明每一步都带:它是常驻的那批,而非常驻的那批只贴一次', async () => {
    const h = startRun(
      [
        { toolCalls: [call('read_file', { path: 'a.md' }, 'c-1')] },
        { toolCalls: [call('read_file', { path: 'b.md' }, 'c-2')] },
        { content: '好了' }
      ],
      {
        mode: 'full',
        hooks: [meta('open', 'beforeAgent'), meta('watch', 'afterToolCall')],
        replies: {
          open: reply({ note: '这个仓库要求先跑测试' }),
          watch: reply({ note: '读过一次文件' })
        }
      }
    )
    await h.running

    // 第 1 步就有常驻说明(beforeAgent 在第 1 步之前跑完),而一次性那批要等第 1 步结束才有
    expect(noteLines(h.model.requests[0])).toEqual(['这个仓库要求先跑测试'])
    expect(noteLines(h.model.requests[1])).toEqual(['这个仓库要求先跑测试', '读过一次文件'])
    // 第 3 次请求里那句一次性的只有一条:它是第 2 步自己新攒的,第 1 步那条已被取走。
    // 缓冲区要是没清,这里就会看到两条一模一样的说明贴在同一个尾部
    expect(noteLines(h.model.requests[2])).toEqual(['这个仓库要求先跑测试', '读过一次文件'])
  })

  it('说明排在目标锚定之前:锚定靠「近期性」起作用,必须留在整份请求的最后一条', async () => {
    const h = startRun(
      [{ toolCalls: [call('run_command', { command: 'ls' }, 'c-1')] }, { content: '好了' }],
      {
        mode: 'full',
        hooks: [meta('watch', 'afterToolCall')],
        replies: { watch: reply({ note: '这条命令只读' }) }
      }
    )
    await h.running
    const second = h.model.requests[1]
    const notes = noteIndexes(second)
    expect(notes).toHaveLength(1)
    // 最后一条是锚定(它带着本轮那句原文),而不是钩子的那条说明
    expect(notes[0]).toBeLessThan(second.messages.length - 1)
    expect(second.messages[second.messages.length - 1].content).toContain('把这个分支推上去')
  })

  it('afterRequest 拿到的是刚落库那一步的真实结论,连同一份端点上报的用量', async () => {
    const h = startRun([{ content: '部署完了', usage: { prompt: 120, completion: 7 } }], {
      mode: 'full',
      hooks: [meta('ledger', 'afterRequest')],
      replies: { ledger: reply({ note: '记下了' }) }
    })
    await h.running

    expect(h.fired).toHaveLength(1)
    expect(h.fired[0].payload.data).toMatchObject({
      content: '部署完了',
      usage: { prompt: 120, completion: 7 },
      model: 'test-model',
      aborted: false
    })
    expect(h.fired[0].payload.run.step).toBe(1)
  })

  it('afterAgent 在终局事件之前触发一次:那步的正文、中止与报错都按出口给对', async () => {
    const done = meta('done', 'afterAgent')
    const h = startRun([{ content: '部署完了' }], {
      mode: 'full',
      hooks: [done],
      replies: { done: reply({ note: '已发通知' }) }
    })
    const result = await h.running

    expect(result.finalContent).toBe('部署完了')
    expect(h.fired).toHaveLength(1)
    expect(h.fired[0].payload.data).toMatchObject({
      finalContent: '部署完了',
      aborted: false,
      error: ''
    })
    // 是那条事件把渲染层放开的:钩子排在它之前才赶得上这一轮的收场
    expect(h.order.indexOf('hook:done')).toBeLessThan(h.order.indexOf('done'))
  })

  it('中止那一路也触发一次且带 aborted,并排在 done 之前', async () => {
    const h = startRun(
      [{ toolCalls: [call('run_command', { command: 'ls' }, 'c-1')] }, { content: '不该走到这里' }],
      {
        mode: 'full',
        hooks: [meta('done', 'afterAgent')],
        replies: { done: reply({ note: '已发通知' }) }
      }
    )
    h.kit.run_command.run = () => {
      h.controller.abort()
      return '命令已执行'
    }
    const result = await h.running

    expect(result.aborted).toBe(true)
    expect(h.fired).toHaveLength(1)
    expect(h.fired[0].payload.data).toMatchObject({ aborted: true, error: '' })
    expect(h.order.indexOf('hook:done')).toBeLessThan(h.order.indexOf('done'))
  })

  it('模型报错那一路也触发一次且带那句原因,并排在 error 之前', async () => {
    const h = startRun([], {
      mode: 'full',
      failStream: true,
      hooks: [meta('done', 'afterAgent')],
      replies: { done: reply({ note: '已发通知' }) }
    })
    const result = await h.running

    expect(result.error).toBe('端点把请求拒了')
    expect(h.fired).toHaveLength(1)
    expect(h.fired[0].payload.data).toMatchObject({ aborted: false, error: '端点把请求拒了' })
    expect(h.order.indexOf('hook:done')).toBeLessThan(h.order.indexOf('error'))
  })
})

describe('beforeRequest 接在裁剪之后', () => {
  it('递出去的那一份就是端点即将收到的那一份:钩子改的是真字节,而不是还没定型的原料', async () => {
    const h = startRun(
      [{ toolCalls: [call('run_command', { command: 'ls' }, 'c-1')] }, { content: '好了' }],
      {
        mode: 'full',
        // 额度紧到那条 4 万字的命令结果必须被缩写:于是「递的是什么」有肉眼看得见的差别
        budget: { window: 8000, input: 3000 },
        hooks: [meta('watch', 'beforeRequest')],
        replies: { watch: reply() }
      }
    )
    h.kit.run_command.run = () => 'x'.repeat(40000)
    await h.running

    // 钩子拿到的是**缩写后**的那一份:裁剪之后再问,而不是把原文递过去再让界面猜
    const given = h.fired[1].payload.data.messages as ChatCompletionMessage[]
    expect(given).toEqual(h.model.requests[1].messages)
    const chars = given.reduce(
      (sum, one) => sum + (typeof one.content === 'string' ? one.content.length : 0),
      0
    )
    expect(chars).toBeLessThan(10000)
    expect(
      given.some(
        (one) => typeof one.content === 'string' && one.content.includes('为塞进上下文窗口')
      )
    ).toBe(true)
    // 而库里那行仍是完整的 4 万字:裁剪只发生在发出去的那一份上,钩子与裁剪都不改史
    expect(h.store.toolRows[0].content).toHaveLength(40000)
  })

  it('改写只作用于发出去的那一份:下一步的历史与库里那些行都还是原文', async () => {
    const rewritten: ChatCompletionMessage[] = [
      { role: 'user', content: '先看一眼 README,不要推分支' }
    ]
    const h = startRun(
      [
        { toolCalls: [call('run_command', { command: 'ls' }, 'c-1')] },
        { toolCalls: [call('run_command', { command: 'pwd' }, 'c-2')] },
        { content: '好了' }
      ],
      {
        mode: 'full',
        // once:第 1 步之后不再问 —— 这一支钉的是「问过一次、改过一次,其余步照旧」
        hooks: [meta('inject', 'beforeRequest', { once: true })],
        replies: { inject: reply({ rewrite: rewritten }) }
      }
    )
    await h.running

    expect(h.model.requests[0].messages.map((one) => one.content)).toEqual([
      '先看一眼 README,不要推分支'
    ])
    // loop 手里那份 context 一字未动:第 2、3 次请求的开头又是用户原话
    expect(h.model.requests[1].messages[0].content).toBe('把这个分支推上去')
    expect(h.model.requests[2].messages[0].content).toBe('把这个分支推上去')
    // 落库的也没有「改写版」的那条提问:那一行本来就存在,而两步的工具结果照常各一行
    expect(h.store.toolRows.map((one) => one.toolCallId)).toEqual(['c-1', 'c-2'])
    expect(h.fired).toHaveLength(1)
  })

  it('同一份回执里 note 与 messages 一起生效:说明不必等下一步,改写也不因加了说明而作废', async () => {
    const rewritten: ChatCompletionMessage[] = [
      { role: 'user', content: '先只看 README,不要推分支' }
    ]
    const h = startRun(
      [{ toolCalls: [call('run_command', { command: 'ls' }, 'c-1')] }, { content: '好了' }],
      {
        mode: 'full',
        hooks: [meta('inject', 'beforeRequest', { once: true })],
        replies: { inject: reply({ note: '这一份经过钩子过目', rewrite: rewritten }) }
      }
    )
    await h.running

    // 那一步发出去的是「改写后的中段 + 本步现加的说明」,两份同一次生效
    expect(h.model.requests[0].messages.map((one) => one.content)).toEqual([
      '先只看 README,不要推分支',
      '[系统说明] 这一份经过钩子过目'
    ])
    // 而那句说明只属于这一次请求:第 2 步的尾部只剩锚定,缓冲区里没有它
    expect(noteLines(h.model.requests[1])).toEqual([])
    expect(h.model.requests[1].messages[0].content).toBe('把这个分支推上去')
  })

  it('钩子塞进来的百万字照样走完那三级裁剪:端点不会因为听信一段外部 JSON 就 400', async () => {
    const h = startRun([{ content: '好了' }], {
      mode: 'full',
      budget: { window: 8000, input: 3000 },
      hooks: [meta('flood', 'beforeRequest')],
      replies: { flood: reply({ rewrite: [{ role: 'user', content: 'x'.repeat(200000) }] }) }
    })
    await h.running

    const sent = h.model.requests[0].messages[0].content as string
    expect(sent.length).toBeLessThan(20000)
    expect(sent).toContain('为塞进上下文窗口')
  })

  it('本步现场追加的说明也排在目标锚定之前:重拼用的是 loop 那一份规则,不留第二处真值', async () => {
    const h = startRun(
      [{ toolCalls: [call('run_command', { command: 'ls' }, 'c-1')] }, { content: '好了' }],
      {
        mode: 'full',
        hooks: [meta('inject', 'beforeRequest')],
        replies: { inject: reply({ note: '这一份要连着上一步一起看' }) }
      }
    )
    await h.running

    // 第 1 步没有锚定(请求本来就紧跟在开头),那条说明因此就排在末位
    expect(h.model.requests[0].messages).toHaveLength(2)
    expect(noteLines(h.model.requests[0])).toEqual(['这一份要连着上一步一起看'])
    const second = h.model.requests[1]
    if (!second) throw new Error('第 2 步的请求没有发出去')
    // 新增的说明仍排在锚定之前:锚定是这一步最后一条,靠「近期性」起作用
    expect(noteIndexes(second)).toEqual([second.messages.length - 2])
    expect(second.messages[second.messages.length - 1].content).toContain('把这个分支推上去')
  })

  it('守卫拒掉的改写不发出去:宁可发原本那一份,也不发一份没验过的', async () => {
    // 凭空造一次调用:端点会以为有个工具真的跑过,守卫按「不在原本那份请求里」整份作废
    const invented: ChatCompletionMessage[] = [
      { role: 'user', content: '把这个分支推上去' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'ghost',
            type: 'function',
            function: { name: 'run_command', arguments: '{"command":"ls"}' }
          }
        ]
      }
    ]
    const h = startRun([{ content: '好了' }], {
      mode: 'full',
      hooks: [meta('inject', 'beforeRequest')],
      replies: { inject: reply({ rewrite: invented }) }
    })
    const result = await h.running

    expect(h.model.requests[0].messages).toEqual([{ role: 'user', content: '把这个分支推上去' }])
    // 那次被凭空造出来的调用没有留下任何一行:改写被拒等于这一步照旧
    expect(h.store.toolRows).toHaveLength(0)
    expect(result.finalContent).toBe('好了')
  })

  it('beforeRequest 否决时那一步一行都不落:afterAgent 报出停在第几步与那一句', async () => {
    const h = startRun([{ content: '不该走到这里' }], {
      hooks: [meta('block', 'beforeRequest'), meta('done', 'afterAgent')],
      replies: {
        block: reply({ block: true, reason: '这一份内容不许出站' }),
        done: reply({ note: '已发通知' })
      }
    })
    const result = await h.running

    expect(result.error).toBe('[被钩子 block 拦下:这一份内容不许出站]')
    expect(result.error).not.toMatch(/请|务必|记得|应该/)
    expect(result.aborted).toBe(false)
    // 否决排在 addStep 之前:没有 assistant 行,也没有一次模型调用,只有那一条 error
    expect(h.model.requests).toHaveLength(0)
    expect(h.store.steps.size).toBe(0)
    expect(h.collected.events.map((e) => e.type)).toEqual(['error'])
    // 中途否决也是「这一轮停了」,所以 afterAgent 要报出停在第几步、因为哪一句
    expect(h.fired.map((one) => one.hook)).toEqual(['block', 'done'])
    expect(h.fired[1].payload.run.step).toBe(1)
    expect(h.fired[1].payload.data).toMatchObject({ aborted: false, error: result.error })
    expect(h.order.indexOf('hook:done')).toBeLessThan(h.order.indexOf('error'))
  })
})

/**
 * 子 run 的现场:测试从这里读它自己那份请求、每一次工具执行看到的边界,以及它自己的落库。
 *
 * 档位默认 `full` —— 这一组不验审批,而免审才是让「跑到子那一步」不卡在等人上的前提;
 * 只有「被钩子拦下时一张卡片都不发」那条要显式回到 `ask`,否则没有卡片是显然的,什么都没钉住。
 */
interface SubRun {
  model: FakeModel
  store: FakeStore
  /** 子里每一次工具执行收到的边界:父子是不是同一个对象全靠它 */
  jail: Array<ToolContext['jail']>
  tool: TestTool
  mode: PermissionMode
}

function makeSubRun(script: ModelStep[], fields: { mode?: PermissionMode } = {}): SubRun {
  const jail: Array<ToolContext['jail']> = []
  return {
    model: makeModel(script),
    store: makeStore(),
    jail,
    mode: fields.mode ?? 'full',
    tool: {
      executed: [],
      run: (_args, context) => {
        jail.push(context.jail)
        return '子里的命令已执行'
      }
    }
  }
}

/**
 * 子 Agent 的派生。`chat/service.ts` 那一层要 DB 与 electron-store 单例,单测跑不起来,
 * 所以照 `createSubAgentSpawner` 的同一条形状写一遍(手法与 `sandbox-run.test.ts` 相同)。
 * 三处必须与生产一致,否则这组用例只是在给自己出题:
 * ① jail 与任务原文都从父级那次 `task` 调用的 `ToolContext` / 参数里来,`hooksForSub` 也从它们来;
 * ② `withHooks` 套在闸门**外面**,与主 run 同一个装饰器、同一个顺序;
 * ③ `runAgent` 收 `hooks: runHooks` 而**不**收 `compaction`(子 Agent 不压缩,也不继承父级说明)。
 */
function makeTaskTool(shared: SubShared, sub: SubRun): ToolDefinition {
  return {
    name: 'task',
    description: '派一个子 Agent(测试替身)',
    parameters: { type: 'object', properties: {} },
    execute: async (args, context) => {
      const prompt = typeof args.prompt === 'string' ? args.prompt : ''
      const scope = subScope(context.callId, 'researcher')
      const hooks = shared.hooksForSub(scope, context.jail, prompt)
      const runner = withHooks(
        withApproval(makeRunner({ run_command: sub.tool }), {
          modeOf: () => sub.mode,
          lists: { allow: [], deny: [] },
          workspace: shared.workspace,
          jail: context.jail,
          scope,
          signal: shared.signal,
          gate: shared.gate,
          runAllow: new Set<string>(),
          mcpToolNames: new Set<string>(),
          emit: shared.emit
        }),
        hooks.toolDeps
      )
      const result = await runAgent({
        scope,
        baseUrl: 'https://model.test/v1',
        model: 'test-model',
        providerId: 'provider-1',
        // 与父级同一个 signal:用户按停止时父子一起停,钩子那侧的进程也跟着收
        signal: shared.signal,
        history: [
          { role: 'system', content: '你是子 Agent,把结论写清楚交回去' },
          { role: 'user', content: prompt }
        ],
        runner,
        workspace: shared.workspace,
        jail: context.jail,
        maxSteps: SUB_AGENT_MAX_STEPS,
        store: sub.store,
        emit: shared.emit,
        hooks: hooks.runHooks,
        stream: sub.model.stream
      })
      return result.finalContent || '子 Agent 已完成'
    }
  }
}

/** `beforeRequest` 那一次触发看到的消息数组;其余事件没有这一格 */
function messagesOf(payload: HookPayload): ChatCompletionMessage[] {
  return (payload.data.messages ?? []) as ChatCompletionMessage[]
}

describe('子 Agent 跑的每一步同样触发钩子', () => {
  it('子 run 的 beforeAgent 触发一次,payload 里的父子三格与步数上限都来自子自己', async () => {
    const sub = makeSubRun([{ content: 'CI 是因为缺依赖红的' }])
    const h = startRun(
      [
        { toolCalls: [call('task', { prompt: '去查一下 CI 为什么红了' }, 'task-1')] },
        { content: '子任务回来了' }
      ],
      {
        mode: 'full',
        hooks: [meta('scribe', 'beforeAgent')],
        subTask: (shared) => makeTaskTool(shared, sub)
      }
    )
    const result = await h.running

    // 父子各一次:同一个声明快照,两个 run
    expect(h.fired.map((one) => one.hook)).toEqual(['scribe', 'scribe'])
    expect(h.fired[0].payload.run.depth).toBe(0)
    expect(h.fired[0].payload.run.maxSteps).toBe(MAIN_AGENT_MAX_STEPS)
    // 这三格是「子绕开了钩子」与「子被当成父」两种错法唯一的可见面:深度、挂在谁下面、谁在跑
    expect(h.fired[1].payload.run).toMatchObject({
      depth: 1,
      parentCallId: 'task-1',
      agent: 'researcher',
      maxSteps: SUB_AGENT_MAX_STEPS
    })
    // 子的 `request` 是派给它的那句话,不是用户对本轮说的那句(§4.6:不新增 `isSubAgent` 那种第二条真值)
    expect(h.fired[1].payload.request).toBe('去查一下 CI 为什么红了')
    expect(result.finalContent).toBe('子任务回来了')
  })

  it('子里那次工具调用被拦下时工具没执行、一张审批卡片都不发:装饰器顺序在子那侧同样成立', async () => {
    const sub = makeSubRun(
      [
        { toolCalls: [call('run_command', { command: 'git push --force' }, 'sub-1')] },
        { content: '那条被拦下了' }
      ],
      { mode: 'ask' }
    )
    const h = startRun(
      [
        { toolCalls: [call('task', { prompt: '把分支强推上去' }, 'task-1')] },
        { content: '子任务回来了' }
      ],
      {
        mode: 'ask',
        // matcher 收窄到 run_command:否则这条钩子会先把父级那次 `task` 本身拦掉
        hooks: [meta('guard', 'beforeToolCall', { matcher: ['run_command'] })],
        replies: { guard: reply({ block: true, reason: '这台机器上禁止强推' }) },
        subTask: (shared) => makeTaskTool(shared, sub)
      }
    )
    await h.running

    // `ask` 档下面内的 `run_command` 本来必弹,而它一次都没弹:钩子在人之前拦住了这一次
    expect(h.collected.of('tool_approval')).toHaveLength(0)
    expect(sub.tool.executed).toHaveLength(0)
    expect(sub.store.toolRows[0].content).toContain('这台机器上禁止强推')
    // 父级那次 `task` 没被 matcher 命中,所以整条链上只有子里这一次触发
    expect(h.fired).toHaveLength(1)
    expect(h.fired[0].payload.run.depth).toBe(1)
    expect(h.fired[0].payload.run.parentCallId).toBe('task-1')
  })

  it('子那份请求里没有父级的历史:父子各有独立说明缓冲与独立的改写链', async () => {
    const sub = makeSubRun([{ content: '查完了' }])
    const h = startRun(
      [
        { toolCalls: [call('get_current_time', {}, 't-1')] },
        { toolCalls: [call('task', { prompt: '去看一眼 CI' }, 'task-1')] },
        { content: '子任务回来了' }
      ],
      {
        mode: 'full',
        hooks: [meta('scribe', 'beforeAgent'), meta('watch', 'beforeRequest')],
        replies: { scribe: reply({ note: '先读 README 再动手' }) },
        subTask: (shared) => makeTaskTool(shared, sub)
      }
    )
    await h.running

    const subRequests = h.fired
      .filter((one) => one.payload.event === 'beforeRequest' && one.payload.run.depth === 1)
      .map((one) => messagesOf(one.payload))
    expect(subRequests.length).toBeGreaterThan(0)
    // 子那份就是它自己的 system + 任务原文 + 它自己那一次 `beforeAgent` 的说明
    // (第 1 步还没有目标锚定),一条父级的行都没混进来 —— 这就是「独立的改写链」
    expect(subRequests[0]).toEqual([
      { role: 'system', content: '你是子 Agent,把结论写清楚交回去' },
      { role: 'user', content: '去看一眼 CI' },
      { role: 'user', content: '[系统说明] 先读 README 再动手' }
    ])
    for (const messages of subRequests) {
      const text = messages.map((one) => (typeof one.content === 'string' ? one.content : ''))
      expect(text.some((one) => one.includes('子里的命令已执行'))).toBe(false)
      expect(text.some((one) => one.includes('2026-10-17 10:00:00'))).toBe(false)
    }
    // 反向半边:子的触发没有把说明写进父级那一份缓冲区 —— 共享的话这里会是两行
    expect(noteLines(sub.model.requests[0])).toEqual(['先读 README 再动手'])
    expect(noteLines(h.model.requests[2])).toEqual(['先读 README 再动手'])
  })

  it('子 run 的工具执行收到与父级同一个 jail 对象:钩子看到的边界因此也是同一道', async () => {
    const sub = makeSubRun([
      { toolCalls: [call('run_command', { command: 'ls' }, 'sub-1')] },
      { content: '在子里跑完了一条命令' }
    ])
    const jail = { root: '/proj', exec: EXEC }
    const h = startRun(
      [
        { toolCalls: [call('task', { prompt: '把结论写到根外' }, 'task-1')] },
        { content: '子任务回来了' }
      ],
      {
        mode: 'full',
        jail,
        hooks: [meta('watch', 'beforeRequest')],
        subTask: (shared) => makeTaskTool(shared, sub)
      }
    )
    await h.running

    // `toBe` 而不是 `toEqual`:换成子 run 自己重算一份,mac 上 `/var → /private/var`
    // 会让父子给出两种边界结论,而钩子日志里那句「跑在哪一侧」就成了第三条真值
    expect(sub.jail[0]).toBe(jail)
    const subTriggered = h.fired.filter((one) => one.payload.run.depth === 1)
    expect(subTriggered.length).toBeGreaterThan(0)
    // 目录与边界一起从父级那份快照来:钩子读到的是同一个工作空间,不是子的某个新算的值
    expect(subTriggered[0].payload.workspace).toBe('/proj')
    // 同一个 jail 对象翻出的边界结论也必须是同一句:父子各算一份就会出现两种「跑在哪一侧」
    expect(subTriggered[0].payload.boundary).toEqual(h.fired[0].payload.boundary)
  })
})
