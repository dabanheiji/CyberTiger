import fs from 'node:fs'
import path from 'node:path'
import { runAgent, MAIN_AGENT_MAX_STEPS, type RunResult } from '../../../src/main/agent/loop'
import { withApproval, type ApprovalDeps } from '../../../src/main/chat/approval'
import { withHooks } from '../../../src/main/chat/hook'
import { createApprovalGate, type ApprovalGate } from '../../../src/main/chat/approvals'
import { createHookSet } from '../../../src/main/hooks/set'
import type { HookSetDeps } from '../../../src/main/hooks/set'
import type { HookPayload } from '../../../src/main/hooks/contract'
import type { HookBoundary } from '../../../src/main/hooks/boundary'
import { hooksLogPath, recentHooks } from '../../../src/main/hooks/log'
import { DEFAULT_HOOK_TIMEOUT_MS } from '../../../src/main/hooks/parser'
import type { HookEvent, HookMeta, HookReply } from '../../../src/main/hooks/types'
import type {
  ApprovalOutcome,
  ApprovalRequest,
  RunScope,
  ToolCallRecord
} from '../../../src/main/chat/dto'
import type { PermissionMode } from '../../../src/main/store/types'
import type { ToolContext, ToolRunner } from '../../../src/main/tools/registry'
import type { ExecBoundary } from '../../../src/main/sandbox'
import {
  makeCall,
  makeEmit,
  makeModel,
  makeRunner,
  makeStore,
  makeTool,
  rootScope,
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
 * 步号与边界有没有一路走到 payload。这几条都只在串起来的时候才露出破绽 ——
 * 尤其「钩子套在闸门外面」这一条,把两层换个顺序,除这里以外没有别处会变红。
 *
 * 大部分用例用**假的执行体**(`HookSetDeps.run`),所以不起进程、结果确定;
 * 最后一组用真的 `runHook` 跑一个真 node 进程,钉的是「接线拼起来之后整条链真的通」。
 */

const DIR = path.join(path.sep, 'hooks', 'demo')
const NODE = process.execPath

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
  scope?: RunScope
  request?: string
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
  notes: () => string[]
  running: Promise<RunResult>
}

function startRun(script: ModelStep[], options: Options = {}): Harness {
  const controller = new AbortController()
  const gate = createApprovalGate()
  const scope = options.scope ?? rootScope()
  const workspace = options.workspace ?? '/proj'
  const kit = makeKit()
  const inner = makeRunner(kit)
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

  const run = createHookSet(options.hooks ?? [], setDeps).forRun({
    scope,
    workspace,
    jail: options.jail,
    // 与 `startRun` 同一条纪律:jail 与沙箱设置来自同一份快照
    sandbox: undefined,
    signal: controller.signal,
    request: options.request ?? '把这个分支推上去',
    maxSteps: MAIN_AGENT_MAX_STEPS
  })

  const runner = withHooks(withApproval(inner, deps), run.toolDeps)
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
    maxSteps: MAIN_AGENT_MAX_STEPS,
    store,
    emit: track,
    stream: model.stream
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
    notes: run.takeNotes,
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
    // 说明进下一步请求是阶段 5 的事,这里先钉住它确实被攒下了
    expect(h.notes()).toEqual(['这条命令输出了三个文件'])
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
    expect(h.notes()).toEqual(['跑完了'])
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
    expect(h.notes()).toEqual([`目录是 ${dir}`])
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
})
