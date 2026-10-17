import fs from 'node:fs'
import path from 'node:path'
import { runAgent, MAIN_AGENT_MAX_STEPS, type RunResult } from '../../../src/main/agent/loop'
import { withApproval, type ApprovalDeps } from '../../../src/main/chat/approval'
import { createApprovalGate, type ApprovalGate } from '../../../src/main/chat/approvals'
import type {
  ApprovalOutcome,
  ApprovalRequest,
  RunScope,
  ToolCallRecord
} from '../../../src/main/chat/dto'
import type { PermissionMode } from '../../../src/main/store/types'
import { createToolRunner } from '../../../src/main/tools/registry'
import type { ToolRunner } from '../../../src/main/tools/registry'
import { readFileTool, writeFileTool } from '../../../src/main/tools/files'
import type { ToolDefinition } from '../../../src/main/tools/types'
import {
  makeCall,
  makeEmit,
  makeModel,
  makeStore,
  rootScope,
  subScope,
  type CollectedRun,
  type FakeModel,
  type FakeStore,
  type ModelStep,
  type TestTool
} from '../../helpers/agent'
import { makeTempDir, removeTempDir } from '../../helpers/temp'

/**
 * jail 接进一次真实 run 之后的行为。
 *
 * 判定表在 `test/main/tools/permission.test.ts`、路径解折在 `test/main/tools/jail.test.ts`、
 * 工具的写侧在 `test/main/tools/files.test.ts`,这一份只管**接线**:
 * jail 有没有随 ToolContext 走到每一次工具执行、主 Agent 与子 Agent 是不是同一个边界、
 * 拒绝有没有正常收场、审批有没有为它让位。这几条都只在串起来的时候才露出破绽。
 *
 * `chat/service.ts` 那一层要 DB 与 electron-store 单例,单测跑不起来,所以子 run 的派生
 * 在这里照 service 的同一条形状写一遍(见 `makeTaskTool`):验的是契约而不是那一行代码。
 */

interface Harness {
  controller: AbortController
  gate: ApprovalGate
  store: FakeStore
  collected: CollectedRun
  notified: ApprovalRequest[]
  model: FakeModel
  running: Promise<RunResult>
}

interface Options {
  mode?: PermissionMode
  workspace?: string
  /**
   * 一次快照、两处共用:交给 `runAgent`(执行侧)与审批 deps(要不要弹卡片侧)。
   * 合成一个参数是故意的 —— 生产里 `startRun` 算出来的就是同一个值;分成两个选项的话,
   * 用例可以让两边给出不同的 jail,界面照样全绿。
   */
  jail?: { root: string }
  inner: ToolRunner
  scope?: RunScope
}

function startRun(script: ModelStep[], options: Options): Harness {
  const controller = new AbortController()
  const gate = createApprovalGate()
  const scope = options.scope ?? rootScope()
  const workspace = options.workspace ?? '/proj'
  const { emit, collected } = makeEmit()
  const store = makeStore()
  const model = makeModel(script)
  const notified: ApprovalRequest[] = []

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
    emit,
    notify: (request) => {
      notified.push(request)
    }
  }

  const running = runAgent({
    scope,
    baseUrl: 'https://model.test/v1',
    model: 'test-model',
    signal: controller.signal,
    history: [{ role: 'user', content: '把结论写进文件' }],
    runner: withApproval(options.inner, deps),
    workspace,
    jail: options.jail,
    maxSteps: MAIN_AGENT_MAX_STEPS,
    store,
    emit,
    stream: model.stream
  })
  return { controller, gate, store, collected, notified, model, running }
}

/** 参数由 JSON.stringify 给:测试里的绝对路径含反斜杠时,手写模板串会拼出非法 JSON */
function call(name: string, args: Record<string, unknown>, id: string): ToolCallRecord {
  return makeCall(name, JSON.stringify(args), id)
}

function approval(h: Harness, index: number): ApprovalRequest {
  const event = h.collected.of('tool_approval')[index]
  if (!event) throw new Error(`第 ${index + 1} 条审批没有弹出来`)
  return event.request
}

/** 审批要等人,而 loop 到工具之间隔着好几个 await,所以轮询着让出事件循环 */
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

/** 每次工具执行看到的边界:父子是不是同一份全靠它 */
interface Seen {
  jail: Array<{ root: string } | undefined>
  workspace: Array<string | undefined>
}

function makeRecorder(result: string, seen: Seen): TestTool {
  return {
    executed: [],
    run: (_args, context) => {
      seen.jail.push(context.jail)
      seen.workspace.push(context.workspace)
      return result
    }
  }
}

function makeSeen(): Seen {
  return { jail: [], workspace: [] }
}

/**
 * 子 Agent 的派生。`service.ts` 的 `createSubAgentSpawner` 是从父级那次 task 调用的
 * ToolContext 里取 `workspace` 与 `jail`,再原样交给子 run 的 `runAgent`
 * (没有往 `SpawnerContext` 加字段 —— 多一条线就多一个忘的机会)。
 * 这里照同一条形状写一遍,钉的是「jail 必定随 ToolContext 抵达 task 工具」:
 * loop 哪天不再往 context 里塞,子 run 就拿到 undefined,这条用例立刻红。
 */
function makeTaskTool(subSeen: Seen): ToolDefinition {
  return {
    name: 'task',
    description: '派一个子 Agent(测试替身)',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, context) => {
      const writeFile = makeRecorder('子 Agent 已写入', subSeen)
      await runAgent({
        scope: subScope(context.callId, 'researcher'),
        baseUrl: 'https://model.test/v1',
        model: 'test-model',
        signal: context.signal ?? new AbortController().signal,
        history: [{ role: 'user', content: '把结论写到根外' }],
        runner: createToolRunner([toDefinition(writeFile)]),
        workspace: context.workspace,
        jail: context.jail,
        maxSteps: MAIN_AGENT_MAX_STEPS,
        store: makeStore(),
        emit: () => {},
        stream: makeModel([
          { toolCalls: [call('write_file', { path: '~/x.txt', content: 'k' }, 'sub-1')] },
          { content: '已完成' }
        ]).stream
      })
      return '子 Agent 已完成'
    }
  }
}

/** 测试替身的工具名必须是审批面内的真名,判定才走真实分支 */
function toDefinition(tool: TestTool): ToolDefinition {
  return {
    name: 'write_file',
    description: '写入文件(测试替身)',
    parameters: { type: 'object', properties: {} },
    volatile: tool.volatile,
    execute: (args, context) => {
      tool.executed.push({ args: JSON.stringify(args), callId: context.callId })
      return tool.run(args, context)
    }
  }
}

let root = ''
let outsideDir = ''

beforeEach(() => {
  // 与生产同一份纪律:根必须 realpath 过,否则 mac 上 `/var → /private/var`
  // 会把根内的路径判成根外
  root = fs.realpathSync(makeTempDir())
  outsideDir = fs.realpathSync(makeTempDir())
})

afterEach(() => {
  removeTempDir(root)
  removeTempDir(outsideDir)
})

describe('jail 随工具上下文到达每一次执行', () => {
  it('主 run 的每一次工具执行都拿到同一份根:闸门装在 loop 的调用点,不装在某个工具里', async () => {
    const seen = makeSeen()
    const writeFile = makeRecorder('已写入', seen)
    const jail = { root }
    const h = startRun(
      [
        {
          toolCalls: [
            call('write_file', { path: 'a.md', content: 'x' }, 'w-1'),
            call('write_file', { path: 'b.md', content: 'x' }, 'w-2')
          ]
        },
        { content: '写好了' }
      ],
      { workspace: root, jail, inner: createToolRunner([toDefinition(writeFile)]) }
    )
    await h.running
    expect(seen.jail).toEqual([jail, jail])
    expect(seen.workspace).toEqual([root, root])
  })

  it('子 Agent 的工具收到的 context.jail.root 与父级同一份:只给主 run 装 jail 就是绕开边界', async () => {
    const subSeen = makeSeen()
    const jail = { root }
    const h = startRun(
      [
        { toolCalls: [call('task', { prompt: '把结论写到根外' }, 'task-1')] },
        { content: '子任务回来了' }
      ],
      {
        workspace: root,
        jail,
        // task 不在审批面内,所以这一轮不该有任何卡片
        inner: createToolRunner([makeTaskTool(subSeen)])
      }
    )
    await h.running

    expect(subSeen.jail).toEqual([jail])
    expect(subSeen.workspace).toEqual([root])
    expect(h.collected.of('tool_approval')).toHaveLength(0)
  })
})

describe('出界的写入要干净收场', () => {
  it('真实 write_file 被 jail 拒掉时只落一条 tool 行,不留孤儿 tool_calls', async () => {
    const target = path.join(outsideDir, 'keep.txt')
    fs.writeFileSync(target, '原来的内容', 'utf8')
    const h = startRun(
      [
        { toolCalls: [call('write_file', { path: target, content: '改掉' }, 'w-1')] },
        { content: '那就写在目录里' }
      ],
      {
        mode: 'full',
        workspace: root,
        jail: { root },
        inner: createToolRunner([writeFileTool])
      }
    )
    await h.running

    // loop 的收尾补行靠 executed 判重:这里必须恰好一条,否则下一轮回放出现两条同 id 的 tool 行
    expect(h.store.toolRows.map((r) => r.toolCallId)).toEqual(['w-1'])
    expect(h.store.toolRows[0].content).toContain('本次写入未执行')
    expect(h.collected.of('tool_result')[0].ok).toBe(false)
    // 拒了就是没执行:旧字节一个都没变
    expect(fs.readFileSync(target, 'utf8')).toBe('原来的内容')
    // 模型读到的是那句陈述句结论,而不是异常堆栈
    const toolMessage = h.model.requests[1].messages.find((m) => m.role === 'tool')
    expect(toolMessage?.content).toContain('之外')
  })

  it('jail 抛出的拒绝不是中止:这一轮照常跑到 done', async () => {
    const h = startRun(
      [
        {
          toolCalls: [
            call('write_file', { path: path.join(outsideDir, 'x.txt'), content: 'x' }, 'w-1')
          ]
        },
        { content: '改写到工作空间里了' }
      ],
      { mode: 'full', workspace: root, jail: { root }, inner: createToolRunner([writeFileTool]) }
    )
    const result = await h.running
    expect(result.aborted).toBe(false)
    expect(result.finalContent).toContain('改写到工作空间里了')
  })
})

describe('审批为 jail 让位', () => {
  it('jail 开着时根外的 write_file 一次 tool_approval 都不发:卡片不该承诺一件注定失败的事', async () => {
    const seen = makeSeen()
    const writeFile = makeRecorder('已写入', seen)
    const h = startRun(
      [
        { toolCalls: [call('write_file', { path: '~/x.txt', content: 'x' }, 'w-1')] },
        { content: '被拒了' }
      ],
      {
        mode: 'ask',
        workspace: root,
        jail: { root },
        inner: createToolRunner([toDefinition(writeFile)])
      }
    )
    await h.running
    // 让位不等于放行:真正拦住它的是工具那一侧(见 test/main/tools/files.test.ts)
    expect(h.collected.of('tool_approval')).toHaveLength(0)
    expect(h.notified).toHaveLength(0)
  })

  it('jail 关闭时根外的 write_file 仍然弹卡片:关掉开关要回到逐条问,而不是两边都不管', async () => {
    const seen = makeSeen()
    const writeFile = makeRecorder('已写入', seen)
    const h = startRun(
      [{ toolCalls: [call('write_file', { path: '~/x.txt', content: 'x' }, 'w-1')] }],
      { mode: 'ask', workspace: root, inner: createToolRunner([toDefinition(writeFile)]) }
    )
    await waitApprovals(h, 1)
    expect(approval(h, 0).summary).toContain('写入工作空间之外的文件')
    decide(h, 0, 'allow')
    await h.running
    expect(seen.jail).toEqual([undefined])
    expect(writeFile.executed).toHaveLength(1)
  })

  it('未选工作空间就没有根,write_file 仍走「一律审批」那条保守老路', async () => {
    const seen = makeSeen()
    const writeFile = makeRecorder('已写入', seen)
    const h = startRun(
      [{ toolCalls: [call('write_file', { path: 'a.md', content: 'x' }, 'w-1')] }],
      { mode: 'ask', workspace: '', inner: createToolRunner([toDefinition(writeFile)]) }
    )
    await waitApprovals(h, 1)
    decide(h, 0, 'allow')
    await h.running
    expect(h.collected.of('tool_approval')).toHaveLength(1)
  })

  it('根外的 read_file 在 jail 开着时照样要问:这一期读侧没收,别让它偷偷免审', async () => {
    const secret = path.join(outsideDir, 'secret.txt')
    fs.writeFileSync(secret, '根外可读', 'utf8')
    const h = startRun([{ toolCalls: [call('read_file', { path: secret }, 'r-1')] }], {
      mode: 'ask',
      workspace: root,
      jail: { root },
      inner: createToolRunner([readFileTool, writeFileTool])
    })
    await waitApprovals(h, 1)
    expect(approval(h, 0).summary).toContain('读取工作空间之外的文件')
    decide(h, 0, 'allow')
    await h.running
    // 免审的是写侧,读侧连结果都照常返回:半套约束要写成断言而不是散文
    expect(h.collected.of('tool_result')[0].ok).toBe(true)
    expect(h.collected.of('tool_result')[0].result).toContain('根外可读')
  })
})
