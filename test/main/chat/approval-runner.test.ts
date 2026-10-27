import { runAgent, MAIN_AGENT_MAX_STEPS, type RunResult } from '../../../src/main/agent/loop'
import { createApprovalGate, type ApprovalGate } from '../../../src/main/chat/approvals'
import { withApproval, type ApprovalDeps } from '../../../src/main/chat/approval'
import type { ApprovalOutcome, ApprovalRequest } from '../../../src/main/chat/dto'
import type { PermissionLists } from '../../../src/main/tools/permission'
import type { PermissionMode } from '../../../src/main/store/types'
import type { ToolExecResult, ToolRunner } from '../../../src/main/tools/registry'
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

/**
 * 审批装饰器的集成测试:走真实的 createToolRunner、真实的 gate 与真实的 loop。
 *
 * 工具全用假实现(名字必须是审批面内的真名,判定才走真实分支),所以这条链上不碰文件系统、
 * 不起子进程 —— 这里要验的是「闸门在工具执行之前、事件顺序、了结方式、放行范围」,
 * 不是 shell 能不能跑。判定表本身在 `test/main/tools/permission.test.ts`,等待语义在
 * `test/main/chat/approvals.test.ts`。
 */

/** 名字是审批面内的真名,判定函数才认;执行体是假的 */
function makeKit(): Record<string, TestTool> {
  return {
    run_command: makeTool('命令已执行'),
    read_file: makeTool('文件内容'),
    write_file: makeTool('已写入'),
    get_current_time: makeTool('2026-10-17 10:00:00')
  }
}

interface HarnessOptions {
  mode?: PermissionMode
  lists?: PermissionLists
  workspace?: string
  scope?: ReturnType<typeof rootScope>
  /** 父子 run 共用一份放行集合时由调用方传进来 */
  gate?: ApprovalGate
  runAllow?: Set<string>
}

interface Harness {
  controller: AbortController
  model: FakeModel
  store: FakeStore
  collected: CollectedRun
  gate: ApprovalGate
  kit: Record<string, TestTool>
  notified: ApprovalRequest[]
  /** 套了闸门的 runner */
  runner: ToolRunner
  /** 闸门里面的那个 runner,靠它断言 definitions 透传 */
  inner: ToolRunner
  runAllow: Set<string>
  /** run 的进行中 Promise:审批会把这一轮停在某次调用上,由用例决定何时 await */
  running: Promise<RunResult>
  setMode: (mode: PermissionMode) => void
}

/**
 * 起一次带审批闸门的 run。
 *
 * 档位用闭包变量而不是常量:装饰器每次调用现读档位,「运行中把档位收紧」那条用例靠它。
 */
function startRun(script: ModelStep[], options: HarnessOptions = {}): Harness {
  const controller = new AbortController()
  let mode: PermissionMode = options.mode ?? 'ask'
  const gate = options.gate ?? createApprovalGate()
  const runAllow = options.runAllow ?? new Set<string>()
  const workspace = options.workspace ?? '/proj'
  const scope = options.scope ?? rootScope()

  const kit = makeKit()
  const inner = makeRunner(kit)
  const { emit, collected } = makeEmit()
  const store = makeStore()
  const model = makeModel(script)
  const notified: ApprovalRequest[] = []

  const deps: ApprovalDeps = {
    modeOf: () => mode,
    lists: options.lists ?? { allow: [], deny: [] },
    workspace,
    scope,
    signal: controller.signal,
    gate,
    runAllow,
    mcpToolNames: new Set<string>(),
    emit,
    notify: (request) => {
      notified.push(request)
    }
  }

  const runner = withApproval(inner, deps)
  const running = runAgent({
    scope,
    baseUrl: 'https://model.test/v1',
    model: 'test-model',
    providerId: 'provider-1',
    signal: controller.signal,
    history: [{ role: 'user', content: '看一下项目里的文件' }],
    runner,
    workspace,
    maxSteps: MAIN_AGENT_MAX_STEPS,
    store,
    emit,
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
    runAllow,
    running,
    setMode: (next) => {
      mode = next
    }
  }
}

/** 第 n 条审批的请求载荷 */
function approval(h: Harness, index: number): ApprovalRequest {
  const events = h.collected.of('tool_approval')
  const event = events[index]
  if (!event) throw new Error(`第 ${index + 1} 条审批没有弹出来`)
  return event.request
}

/**
 * 等到第 n 条审批弹出去。
 *
 * 装饰器在 emit 之后**同步**登记等待,所以看到事件就能立刻 decide,不需要再等一层。
 * 但 loop 到工具之间隔着模型调用与落库的好几个 await,所以要轮询着让出事件循环。
 */
async function waitApprovals(h: Harness, n: number): Promise<void> {
  for (let i = 0; i < 50 && h.collected.of('tool_approval').length < n; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  if (h.collected.of('tool_approval').length < n) {
    throw new Error(`只弹出了 ${h.collected.of('tool_approval').length} 条审批`)
  }
}

/** 按下卡片上的那颗按钮 */
function decide(h: Harness, index: number, outcome: ApprovalOutcome, reason?: string): void {
  if (!h.gate.decide(approval(h, index).approvalId, outcome, reason)) {
    throw new Error(`第 ${index + 1} 条审批已经不等了`)
  }
}

describe('免审批的那条路径不留痕迹', () => {
  it('完全访问档一次都不发审批事件:界面不会被空卡片打断', async () => {
    const h = startRun(
      [
        { toolCalls: [makeCall('run_command', '{"command":"rm -rf /tmp/scratch"}', 'cmd-1')] },
        { content: '已清理' }
      ],
      { mode: 'full' }
    )
    await h.running
    expect(h.collected.of('tool_approval')).toHaveLength(0)
    expect(h.notified).toHaveLength(0)
    expect(h.kit.run_command.executed).toHaveLength(1)
    expect(h.collected.of('tool_result')[0].ok).toBe(true)
  })

  it('审批面之外的工具在任何档位都不问:get_current_time 不碰本机状态', async () => {
    const h = startRun([
      { toolCalls: [makeCall('get_current_time', '{}', 'time-1')] },
      { content: '现在十点' }
    ])
    await h.running
    expect(h.collected.of('tool_approval')).toHaveLength(0)
    expect(h.kit.get_current_time.executed).toHaveLength(1)
  })

  it('白名单命中即免审批,一次审批都不该发', async () => {
    const h = startRun(
      [{ toolCalls: [makeCall('run_command', '{"command":"npm run build"}', 'cmd-1')] }],
      { lists: { allow: ['npm run build'], deny: [] } }
    )
    await h.running
    expect(h.collected.of('tool_approval')).toHaveLength(0)
    expect(h.kit.run_command.executed).toHaveLength(1)
  })

  it('参数不是合法 JSON 时不进审批:那句报错由内层 runner 给出更准', async () => {
    // 闸门看不懂参数,就不该拿它去判风险;判错方向反而会把一条根本不会执行的调用弹成卡片
    const h = startRun([{ toolCalls: [makeCall('run_command', '不是 JSON', 'cmd-1')] }])
    await h.running
    expect(h.collected.of('tool_approval')).toHaveLength(0)
    expect(h.collected.of('tool_result')[0].result).toContain('不是合法的 JSON')
  })

  it('definitions 与内层 runner 是同一份:加闸门不会让「发给模型的工具表」和「能执行的范围」错位', () => {
    const h = startRun([])
    expect(h.runner.definitions).toBe(h.inner.definitions)
    expect(h.runner.toChatCompletionTools()).toEqual(h.inner.toChatCompletionTools())
  })
})

describe('审批卡片的内容与时序', () => {
  it('tool_approval 排在同一次调用的 tool_call 之后:工具链先有这一步,卡片才有所属', async () => {
    const h = startRun([{ toolCalls: [makeCall('run_command', '{"command":"ls"}', 'cmd-1')] }])
    await waitApprovals(h, 1)
    const order = h.collected.events.map((e) => e.type)
    expect(order.indexOf('tool_call')).toBeLessThan(order.indexOf('tool_approval'))
    decide(h, 0, 'allow')
    await h.running
  })

  it('载荷是判定的全部事实:命令行、实际目录、放行键,渲染层不再自己算一遍', async () => {
    const h = startRun([{ toolCalls: [makeCall('run_command', '{"command":"ls"}', 'cmd-1')] }])
    await waitApprovals(h, 1)
    expect(approval(h, 0)).toMatchObject({
      callId: 'cmd-1',
      tool: 'run_command',
      summary: '执行命令:ls',
      risk: 'low',
      runAllowKey: 'ls [cwd=/proj]',
      agent: ''
    })
    expect(approval(h, 0).detail).toContain('工作目录:/proj')
    decide(h, 0, 'allow')
    await h.running
  })

  it('等待中的那条按会话登记:渲染层重载后能把还挂着的卡片拉回来', async () => {
    const h = startRun([{ toolCalls: [makeCall('run_command', '{"command":"ls"}', 'cmd-1')] }])
    await waitApprovals(h, 1)
    const [pending] = h.gate.list()
    expect(pending?.approvalId).toBe(approval(h, 0).approvalId)
    expect(pending?.conversationId).toBe('conv-1')
    decide(h, 0, 'allow')
    await h.running
  })

  it('窗口不在前台时 notify 收到同一条请求:审批停在人身上,而人可能没在看这个窗口', async () => {
    const h = startRun([{ toolCalls: [makeCall('run_command', '{"command":"ls"}', 'cmd-1')] }])
    await waitApprovals(h, 1)
    expect(h.notified).toHaveLength(1)
    expect(h.notified[0].approvalId).toBe(approval(h, 0).approvalId)
    decide(h, 0, 'allow')
    await h.running
  })

  it('免审批的调用一次 notify 都不发:通知只属于「等人」的调用', async () => {
    const h = startRun([{ toolCalls: [makeCall('get_current_time', '{}', 'time-1')] }], {
      mode: 'ask'
    })
    await h.running
    expect(h.notified).toHaveLength(0)
  })
})

describe('用户拒绝,或没人拒绝', () => {
  it('拒绝的结论作为 tool 行落库:每个已落库的调用都有对应响应,不留孤儿', async () => {
    const h = startRun(
      [
        { toolCalls: [makeCall('run_command', '{"command":"git push --force"}', 'cmd-1')] },
        { content: '那我不推了' }
      ],
      { mode: 'auto' }
    )
    await waitApprovals(h, 1)
    decide(h, 0, 'deny', '这个分支别人在用')
    await h.running

    // 操作没进行:内层工具一次都没被执行
    expect(h.kit.run_command.executed).toHaveLength(0)
    // loop 的收尾补行靠 executed 判重,这里必须恰好一条,否则下一轮回放出现两条同 id 的 tool 行
    expect(h.store.toolRows.map((r) => r.toolCallId)).toEqual(['cmd-1'])
    expect(h.store.toolRows[0].content).toContain('用户拒绝了这次操作')
    expect(h.store.toolRows[0].content).toContain('这个分支别人在用')
    expect(h.collected.of('tool_result')[0].ok).toBe(false)
    // 模型读到的就是这条结论,据此改道而不是重问
    const toolMessage = h.model.requests[1].messages.find((m) => m.role === 'tool')
    expect(toolMessage?.content).toContain('用户拒绝了这次操作')
  })

  it('拒绝的文案是陈述句,不含「请换个方式」这类祈使:模型会把祈使当本轮待办', async () => {
    const h = startRun([{ toolCalls: [makeCall('run_command', '{"command":"ls"}', 'cmd-1')] }])
    await waitApprovals(h, 1)
    decide(h, 0, 'deny')
    await h.running
    const result = h.collected.of('tool_result')[0].result
    expect(result).not.toMatch(/请|务必|记得/)
    // 没补原因就不该凭空写一句「用户给出的原因:」
    expect(result).toBe('用户拒绝了这次操作,操作没有进行。')
  })

  it('同参数的第二次命中本轮去重:不再弹第二张卡片', async () => {
    // loop 的缓存先于闸门:被拒的结果同样是「这次调用的结论」,同一个问题不该打断用户两次
    const h = startRun([
      {
        toolCalls: [
          makeCall('run_command', '{"command":"ls"}', 'cmd-1'),
          makeCall('run_command', '{"command":"ls"}', 'cmd-2')
        ]
      }
    ])
    await waitApprovals(h, 1)
    decide(h, 0, 'deny')
    await h.running
    expect(h.collected.of('tool_approval')).toHaveLength(1)
    // 被拒的那次没执行,第二次也不会:缓存里存的正是那条「用户拒绝了」的结论
    expect(h.kit.run_command.executed).toHaveLength(0)
    const results = h.collected.of('tool_result')
    expect(results.map((e) => e.reused)).toEqual([false, true])
    expect(results[1].result).toBe(results[0].result)
    expect(results[1].ok).toBe(false)
  })

  it('等待期间按下停止:这一轮按「没有做出审批」收场,既不执行也不悬挂', async () => {
    const h = startRun(
      [
        { toolCalls: [makeCall('run_command', '{"command":"ls"}', 'cmd-1')] },
        { content: '不该走到这一步' }
      ],
      { mode: 'ask' }
    )
    await waitApprovals(h, 1)
    h.controller.abort()
    const result = await h.running

    expect(result.aborted).toBe(true)
    expect(h.kit.run_command.executed).toHaveLength(0)
    expect(h.store.toolRows.map((r) => r.toolCallId)).toEqual(['cmd-1'])
    expect(h.store.toolRows[0].content).toContain('[本轮已中止,没有做出审批,操作没有进行]')
    // 中止后不再向模型发起下一步:这一轮就地收场
    expect(h.model.requests).toHaveLength(1)
  })

  it('无人应答超时按「没有人做出决定」收场,而不是替用户批准或把整轮吊住', async () => {
    // 生产是 3 分钟,单测里等不起,所以注入一个极短的窗口
    const h = startRun([{ toolCalls: [makeCall('run_command', '{"command":"ls"}', 'cmd-1')] }], {
      gate: createApprovalGate(1)
    })
    await h.running
    expect(h.kit.run_command.executed).toHaveLength(0)
    expect(h.collected.of('tool_result')[0].result).toContain('等待审批超时')
    expect(h.gate.list()).toEqual([])
  })
})

describe('本轮同类都允许', () => {
  it('放行一整类后同类不再问,换一类照问:按钮的粒度就是键的粒度', async () => {
    const h = startRun([
      {
        toolCalls: [
          makeCall('run_command', '{"command":"ls"}', 'cmd-1'),
          makeCall('run_command', '{"command":"ls -la"}', 'cmd-2'),
          makeCall('run_command', '{"command":"git status"}', 'cmd-3')
        ]
      }
    ])
    await waitApprovals(h, 1)
    decide(h, 0, 'allow_run')
    // `ls` 与 `ls -la` 同键(键只取到命令名),第二条不再弹
    await waitApprovals(h, 2)
    expect(approval(h, 1).runAllowKey).toBe('git status [cwd=/proj]')
    decide(h, 1, 'allow')
    await h.running

    expect(h.collected.of('tool_approval')).toHaveLength(2)
    expect(h.kit.run_command.executed).toHaveLength(3)
  })

  it('点「允许这一次」不放行整类:下一次同类仍要问', async () => {
    const h = startRun([
      {
        toolCalls: [
          makeCall('run_command', '{"command":"ls"}', 'cmd-1'),
          makeCall('run_command', '{"command":"ls -la"}', 'cmd-2')
        ]
      }
    ])
    await waitApprovals(h, 1)
    decide(h, 0, 'allow')
    await waitApprovals(h, 2)
    expect(h.collected.of('tool_approval')).toHaveLength(2)
    decide(h, 1, 'allow')
    await h.running
    expect(h.runAllow.size).toBe(0)
  })

  it('父子 run 共用同一份放行集合:主 Agent 批过的类,子 Agent 不再问一遍', async () => {
    const h = startRun([{ toolCalls: [makeCall('run_command', '{"command":"ls"}', 'cmd-1')] }])
    await waitApprovals(h, 1)
    decide(h, 0, 'allow_run')
    await h.running

    // 子 run 用同一个 gate 与同一个 runAllow(service 就是这么接的)
    const sub = startRun([{ toolCalls: [makeCall('run_command', '{"command":"ls"}', 'cmd-2')] }], {
      scope: subScope('task-1', 'researcher'),
      gate: h.gate,
      runAllow: h.runAllow
    })
    await sub.running
    expect(sub.collected.of('tool_approval')).toHaveLength(0)
    expect(sub.kit.run_command.executed).toHaveLength(1)
  })

  it('档位每次调用现读:运行中把「完全访问」收紧成「询问审批」,下一次调用就问出去了', async () => {
    const h = startRun([], { mode: 'full' })
    const first = await h.runner.execute('run_command', '{"command":"ls"}', { callId: 'cmd-1' })
    expect(first).toEqual({ ok: true, result: '命令已执行' })
    expect(h.collected.of('tool_approval')).toHaveLength(0)

    h.setMode('ask')
    const pending = h.runner.execute('run_command', '{"command":"ls"}', { callId: 'cmd-2' })
    await waitApprovals(h, 1)
    expect(approval(h, 0).callId).toBe('cmd-2')
    decide(h, 0, 'allow')
    const second: ToolExecResult = await pending
    expect(second.ok).toBe(true)
  })
})
