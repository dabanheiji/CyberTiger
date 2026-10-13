import {
  MAIN_AGENT_MAX_STEPS,
  runAgent,
  type RunAgentParams,
  type RunCompactRequest,
  type RunCompactResult,
  type RunCompactor
} from '../../../src/main/agent/loop'
import { STEP_LIMIT_PROMPT } from '../../../src/main/agent/prompt'
import { SUMMARY_BLOCK_PREFIX, isSummaryBlock, summaryBlock } from '../../../src/main/agent/compact'
import type { ContextBudget } from '../../../src/main/agent/context'
import { estimateRequestTokens } from '../../../src/main/tokens/estimate'
import type { ChatCompletionMessage } from '../../../src/main/chat/llm'
import type { ChatStreamEvent, RunScope } from '../../../src/main/chat/dto'
import {
  makeCall,
  makeEmit,
  makeModel,
  makeRunner,
  makeStore,
  makeTool,
  rootScope,
  subScope,
  type ModelStep,
  type TestTool
} from '../../helpers/agent'

interface RunOptions {
  script?: ModelStep[]
  tools?: Record<string, TestTool>
  history?: ChatCompletionMessage[]
  maxSteps?: number
  scope?: RunScope
  signal?: AbortSignal
  /** 覆盖脚本化的模型,用于模拟报错 */
  stream?: RunAgentParams['stream']
  /** 上下文预算;不给则用 loop 的默认值(32k 兜底窗口) */
  budget?: ContextBudget
  /** run 中途压缩的注入点;不传即子 Agent 那种「不压缩」的 run */
  compaction?: RunAgentParams['compaction']
}

interface RunOutcome {
  result: Awaited<ReturnType<typeof runAgent>>
  requests: ReturnType<typeof makeModel>['requests']
  store: ReturnType<typeof makeStore>
  events: ChatStreamEvent[]
}

async function run(options: RunOptions = {}): Promise<RunOutcome> {
  const model = makeModel(options.script ?? [{ content: '回答完毕' }])
  const store = makeStore()
  const { emit, collected } = makeEmit()
  const result = await runAgent({
    scope: options.scope ?? rootScope(),
    baseUrl: 'https://model.test/v1',
    model: 'test-model',
    signal: options.signal ?? new AbortController().signal,
    history: options.history ?? [{ role: 'user', content: '现在几点了' }],
    runner: makeRunner(options.tools ?? {}),
    maxSteps: options.maxSteps ?? MAIN_AGENT_MAX_STEPS,
    store,
    emit,
    ...(options.budget ? { budget: options.budget } : {}),
    ...(options.compaction ? { compaction: options.compaction } : {}),
    stream: options.stream ?? model.stream
  })
  return { result, requests: model.requests, store, events: collected.events }
}

/** 内容末条消息,锚定与循环控制都追加在这里 */
function lastContentOf(messages: ChatCompletionMessage[]): string {
  const last = messages[messages.length - 1]
  return typeof last?.content === 'string' ? last.content : ''
}

/**
 * 断言一条请求里没有孤儿 tool_calls:每个 assistant 发起的调用都能在同一条请求里
 * 找到对应的 tool 行。严格的 OpenAI 兼容端点对缺失响应的调用直接返回 400,
 * 而裁剪最容易在这里出错 —— 所以每条被压缩过的请求都要过这一关。
 */
function expectNoOrphanCalls(messages: ChatCompletionMessage[]): void {
  const answered = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id))
  const orphans = messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.tool_calls ?? [])
    .filter((call) => !answered.has(call.id))
  expect(orphans.map((c) => c.id)).toEqual([])
}

describe('runAgent 的基本循环', () => {
  it('模型直接回答时只调用一次,正文逐步累加', async () => {
    const { result, requests, store, events } = await run({
      script: [{ content: '前半', reasoning: '先想想' }]
    })
    expect(requests.length).toBe(1)
    expect(result).toEqual({ finalContent: '前半', aborted: false })
    const step = [...store.steps.values()][0]
    expect(step.content).toBe('前半')
    expect(step.reasoning).toBe('先想想')
    // reasoning 与 content 分开推流:1 条思考 + 正文被拆成 2 条;用量在正文之后单独一条
    expect(events.map((e) => e.type)).toEqual([
      'step_start',
      'delta',
      'delta',
      'delta',
      'usage',
      'done'
    ])
    expect(events.filter((e) => e.type === 'delta')).toMatchObject([
      { reasoning: '先想想', content: '' },
      { reasoning: '', content: '前' },
      { reasoning: '', content: '半' }
    ])
  })

  it('把工具结果作为 tool 消息回填后再问模型', async () => {
    const time = makeTool('{"iso":"2026-10-08T12:00:00Z"}')
    const call = makeCall('get_current_time', '{}')
    const { result, requests, store } = await run({
      script: [{ toolCalls: [call] }, { content: '现在是 12 点' }],
      tools: { get_current_time: time }
    })
    expect(result.finalContent).toBe('现在是 12 点')
    expect(time.executed.length).toBe(1)

    const second = requests[1].messages
    const assistant = second.find((m) => m.role === 'assistant')
    expect(assistant?.role === 'assistant' && assistant.tool_calls?.[0].id).toBe(call.id)
    const toolRow = second.find((m) => m.role === 'tool')
    expect(toolRow?.role === 'tool' && toolRow.content).toBe('{"iso":"2026-10-08T12:00:00Z"}')
    expect(store.toolRows[0].toolCallId).toBe(call.id)
  })

  it('没有任何工具调用可用时也能收尾', async () => {
    const { result, requests } = await run({ script: [{ content: '直接答' }] })
    expect(requests[0].tools).toEqual([])
    expect(result.finalContent).toBe('直接答')
  })

  it('停在工具步时用最近一次非空正文作为最终结论', async () => {
    const time = makeTool('结果')
    const { result } = await run({
      script: [{ content: '我先查一下' }, { toolCalls: [makeCall('t', '{}')] }],
      tools: { t: time }
    })
    expect(result.finalContent).toBe('我先查一下')
  })
})

describe('本轮工具去重', () => {
  it('同名同参只执行一次,第二次标记为复用', async () => {
    const probe = makeTool('唯一结果')
    const a = makeCall('probe', '{"q":"x"}')
    const b = makeCall('probe', '{"q":"x"}')
    const { store, events } = await run({
      script: [{ toolCalls: [a, b] }, { content: '好了' }],
      tools: { probe }
    })
    expect(probe.executed.length).toBe(1)
    // 两次调用都要有 tool 行,否则第二个 tool_call_id 没有响应
    expect(store.toolRows.map((r) => r.toolCallId)).toEqual([a.id, b.id])
    expect(store.toolRows.every((r) => r.content === '唯一结果')).toBe(true)

    const results = events.filter((e) => e.type === 'tool_result')
    expect(results.map((r) => ('reused' in r ? r.reused : undefined))).toEqual([false, true])
  })

  it('参数只是键序不同也判为同一次调用', async () => {
    const probe = makeTool('r')
    await run({
      script: [
        {
          toolCalls: [makeCall('probe', '{"a":1,"b":2}'), makeCall('probe', '{"b":2,"a":1}')]
        },
        { content: 'ok' }
      ],
      tools: { probe }
    })
    expect(probe.executed.length).toBe(1)
  })

  it('参数含空格与换行时按语义比较,不按原文', async () => {
    const probe = makeTool('r')
    await run({
      script: [
        { toolCalls: [makeCall('probe', '{ "a" : 1 }'), makeCall('probe', '{"a":1}')] },
        { content: 'ok' }
      ],
      tools: { probe }
    })
    expect(probe.executed.length).toBe(1)
  })

  it('参数不是合法 JSON 时按原文比对,失败结果也被复用', async () => {
    const probe = makeTool('r')
    const { store, events } = await run({
      script: [
        { toolCalls: [makeCall('probe', '{坏', 'b1'), makeCall('probe', '{坏', 'b2')] },
        { content: 'ok' }
      ],
      tools: { probe }
    })
    // 参数校验在注册表里就把非法 JSON 拦下,工具本体一次都没执行
    expect(probe.executed.length).toBe(0)
    expect(store.toolRows.every((r) => r.content.includes('不是合法的 JSON'))).toBe(true)
    // 但两次调用都要有 tool 行,且第二次命中缓存
    const results = events.filter((e) => e.type === 'tool_result')
    expect(results.map((r) => ('reused' in r ? r.reused : undefined))).toEqual([false, true])

    const probe2 = makeTool('r')
    const second = await run({
      script: [
        { toolCalls: [makeCall('probe', '{坏', 'b3'), makeCall('probe', '{更坏', 'b4')] },
        { content: 'ok' }
      ],
      tools: { probe: probe2 }
    })
    // 原文不同就是两个 key,第二次不复用
    const secondResults = second.events.filter((e) => e.type === 'tool_result')
    expect(secondResults.map((r) => ('reused' in r ? r.reused : undefined))).toEqual([false, false])
  })

  it('参数是合法 JSON 但不是对象时退回原文比对', async () => {
    // 数组/标量能过 JSON.parse,却进不了 toolKey 的排序分支,只能按原文比
    const probe = makeTool('r')
    const { store, events } = await run({
      script: [
        { toolCalls: [makeCall('probe', '[1]', 'n1'), makeCall('probe', '[1]', 'n2')] },
        { content: 'ok' }
      ],
      tools: { probe }
    })
    // 注册表要求参数是对象,所以两次都被拦下,第二次还复用了失败结果
    expect(probe.executed.length).toBe(0)
    expect(store.toolRows.map((r) => r.content)).toEqual([
      '参数必须是 JSON 对象',
      '参数必须是 JSON 对象'
    ])
    const results = events.filter((e) => e.type === 'tool_result')
    expect(results.map((r) => ('reused' in r ? r.reused : undefined))).toEqual([false, true])

    const second = await run({
      script: [
        { toolCalls: [makeCall('probe', '[1]', 'n3'), makeCall('probe', '[2]', 'n4')] },
        { content: 'ok' }
      ],
      tools: { probe: makeTool('r') }
    })
    // 原文不同就是两个 key,第二次不复用
    const secondResults = second.events.filter((e) => e.type === 'tool_result')
    expect(secondResults.map((r) => ('reused' in r ? r.reused : undefined))).toEqual([false, false])
  })

  it('空参数与显式 {} 被判成两次调用(已知不一致)', async () => {
    const probe = makeTool('r')
    await run({
      script: [
        { toolCalls: [makeCall('probe', '   ', 'e1'), makeCall('probe', '{}', 'e2')] },
        { content: 'ok' }
      ],
      tools: { probe }
    })
    // toolKey 对空参数短路成 "name|{}",而 "{}" 走排序分支得到 "name|[]",
    // 于是同一个无参工具真跑了两次 —— 去重本意是要挡住这种调用。
    expect(probe.executed.length).toBe(2)
  })

  it('同名不同参各执行一次', async () => {
    const probe = makeTool('r')
    await run({
      script: [
        { toolCalls: [makeCall('probe', '{"q":"a"}'), makeCall('probe', '{"q":"b"}')] },
        { content: 'ok' }
      ],
      tools: { probe }
    })
    expect(probe.executed.length).toBe(2)
  })

  it('缓存不跨 run:新 run 会重新执行同样的调用', async () => {
    const probe = makeTool('r')
    const call = makeCall('probe', '{}')
    const script: ModelStep[] = [{ toolCalls: [call] }, { content: 'ok' }]
    await run({ script: [...script], tools: { probe } })
    await run({ script: [...script], tools: { probe } })
    expect(probe.executed.length).toBe(2)
  })
})

describe('目标锚定', () => {
  it('第 1 步不注入锚定,第 2 步起追加在消息末尾', async () => {
    const probe = makeTool('r')
    const { requests } = await run({
      script: [
        { toolCalls: [makeCall('probe', '{"i":1}', 'c1')] },
        { toolCalls: [makeCall('probe', '{"i":2}', 'c2')] },
        { content: '结束' }
      ],
      // c1 与 c2 参数不同才不会命中去重
      tools: { probe }
    })
    expect(requests.length).toBe(3)
    expect(lastContentOf(requests[0].messages)).toBe('现在几点了')
    for (const req of requests.slice(1)) {
      const last = lastContentOf(req.messages)
      expect(last).toMatch(/^\[系统提醒\]/)
      expect(last).toContain('现在几点了')
      // 只追加一次,且不影响更早的消息
      expect(req.messages.filter((m) => m.role === 'user')).toHaveLength(2)
    }
  })

  it('锚定用 user 角色而非 system,兼容个别端点的约束', async () => {
    const probe = makeTool('r')
    const { requests } = await run({
      script: [{ toolCalls: [makeCall('probe', '{}')] }, { content: '结束' }],
      tools: { probe }
    })
    const anchored = requests[1].messages[requests[1].messages.length - 1]
    expect(anchored.role).toBe('user')
  })

  it('超长请求在锚定里被截到 200 字并加省略号', async () => {
    const probe = makeTool('r')
    const long = '路'.repeat(300)
    const { requests } = await run({
      history: [{ role: 'user', content: long }],
      script: [{ toolCalls: [makeCall('probe', '{}')] }, { content: '结束' }],
      tools: { probe }
    })
    const anchored = lastContentOf(requests[1].messages)
    expect(anchored).toContain(`${'路'.repeat(200)}…`)
    expect(anchored).not.toContain(`${'路'.repeat(201)}`)
  })

  it('历史里没有带内容的 user 消息时不做锚定', async () => {
    const probe = makeTool('r')
    const { requests } = await run({
      history: [{ role: 'system', content: '只有系统消息' }],
      script: [{ toolCalls: [makeCall('probe', '{}')] }, { content: '结束' }],
      tools: { probe }
    })
    expect(lastContentOf(requests[1].messages)).not.toMatch(/^\[系统提醒\]/)
  })

  it('锚定声明「已拿到的不需要重新获取」,且不出现诱导重调的祈使句', async () => {
    const probe = makeTool('r')
    const { requests } = await run({
      script: [{ toolCalls: [makeCall('probe', '{}')] }, { content: '结束' }],
      tools: { probe }
    })
    // 锚定以 user 角色重复了原始请求,对小模型就像一条新提问:实测中它据此连着三步
    // 换着参数重调 get_current_time。所以锚定必须自己补上"已有的够用",且不能说反话。
    const anchored = lastContentOf(requests[1].messages)
    expect(anchored).toContain('已拿到的不需要重新获取')
    expect(anchored).not.toMatch(/请重新调用|再次调用|如需.*调用/)
  })
})

describe('步数上限', () => {
  it('达到上限的那次调用不再下发工具,并要求模型收尾', async () => {
    const probe = makeTool('r')
    const { requests, events } = await run({
      maxSteps: 2,
      script: [
        { toolCalls: [makeCall('probe', '{"i":1}', 'a1')] },
        { toolCalls: [makeCall('probe', '{"i":2}', 'a2')] },
        { toolCalls: [makeCall('probe', '{"i":3}', 'a3')] }
      ],
      tools: { probe }
    })
    expect(requests.length).toBe(3)
    expect(requests[0].tools?.length).toBe(1)
    expect(requests[2].tools).toBeUndefined()
    // 收尾提示在前、目标锚定在后,两条都以 user 消息追加在末尾
    const tail = requests[2].messages.slice(-2)
    expect(tail.map((m) => m.content)).toEqual([
      STEP_LIMIT_PROMPT,
      expect.stringContaining('现在几点了')
    ])
    // 收尾步的第三次调用没有被执行
    expect(probe.executed.length).toBe(2)
    expect(events.at(-1)?.type).toBe('done')
  })

  it('上限为 0 时第一次调用就是收尾步', async () => {
    const { requests } = await run({ maxSteps: 0, script: [{ content: '直接答' }] })
    expect(requests.length).toBe(1)
    expect(requests[0].tools).toBeUndefined()
  })
})

describe('中止', () => {
  it('预先中止时一次模型都不调用', async () => {
    const controller = new AbortController()
    controller.abort()
    const { result, requests, store, events } = await run({ signal: controller.signal })
    expect(requests.length).toBe(0)
    expect(store.steps.size).toBe(0)
    expect(result.aborted).toBe(true)
    expect(events.map((e) => e.type)).toEqual(['done'])
    expect(events[0]).toMatchObject({ aborted: true })
  })

  it('流式途中中止时保留已收到的内容', async () => {
    const controller = new AbortController()
    const probe = makeTool(() => {
      controller.abort()
      return '结果'
    })
    const { result, store, events } = await run({
      signal: controller.signal,
      script: [{ content: '一半的答案', toolCalls: [makeCall('probe', '{}')] }],
      tools: { probe }
    })
    expect(result.aborted).toBe(true)
    expect([...store.steps.values()][0].content).toBe('一半的答案')
    expect(events.map((e) => e.type)).toContain('done')
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  it('工具执行到一半中止时,没跑的调用补占位 tool 行,不留孤儿', async () => {
    const controller = new AbortController()
    const probe = makeTool(() => {
      controller.abort()
      return '第一个结果'
    })
    const first = makeCall('probe', '{"i":1}', 'a1')
    const second = makeCall('probe', '{"i":2}', 'a2')
    const { store, events } = await run({
      signal: controller.signal,
      script: [{ toolCalls: [first, second] }, { content: '不该走到这里' }],
      tools: { probe }
    })
    const step = [...store.steps.values()][0]
    expect(step.calls.map((c) => c.id)).toEqual([first.id, second.id])
    // assistant 行带两个调用,两个都得有 tool 行:第二个是占位结论。
    // 少了这一行,下一轮回放就是「有调用无响应」,严格端点直接 400。
    expect(store.toolRows.map((r) => r.toolCallId)).toEqual([first.id, second.id])
    expect(store.toolRows[1].content).toBe('[本轮未执行,无结果]')
    // 界面也要收到收尾,否则那次调用永远显示成"进行中"
    const settled = events.find((e) => e.type === 'tool_result' && e.callId === second.id)
    expect(settled).toMatchObject({ ok: false })
  })

  it('收尾步模型仍返回调用时,同样补齐 tool 行', async () => {
    const probe = makeTool('真实结果')
    const orphan = makeCall('probe', '{"i":9}', 'z9')
    const { store } = await run({
      maxSteps: 1,
      script: [{ toolCalls: [makeCall('probe', '{"i":1}', 'a1')] }, { toolCalls: [orphan] }],
      tools: { probe }
    })
    // 第一次真实执行 + 收尾步那次调用补的占位行
    expect(store.toolRows.map((r) => r.toolCallId)).toEqual(['a1', 'z9'])
    expect(store.toolRows[1].content).toBe('[本轮未执行,无结果]')
    expect(probe.executed.length).toBe(1)
  })
})

describe('失败与收尾', () => {
  it('模型报错时主 run 发 error 事件并带可读文本', async () => {
    const { result, events, store } = await run({
      stream: async () => {
        throw new Error('无法连接到 https://model.test/v1,请检查 Base URL')
      }
    })
    expect(result.error).toContain('请检查 Base URL')
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      msg: expect.stringContaining('请检查 Base URL')
    })
    expect(store.steps.size).toBe(0)
  })

  it('子 Agent 的 run 不发 done / error,也不调整会话排序', async () => {
    const { result, events, store } = await run({
      scope: subScope('task-1', 'researcher'),
      stream: async () => {
        throw new Error('子任务里的网络错误')
      }
    })
    expect(result.error).toContain('子任务里的网络错误')
    expect(events.map((e) => e.type)).toEqual(['step_start'])
    expect(store.touched).toEqual([])
  })

  it('主 run 结束时把会话顶到最前', async () => {
    const { store } = await run()
    expect(store.touched).toEqual(['conv-1'])
  })

  it('三者全空的步骤直接删掉,不留空 assistant 行', async () => {
    const { store, events } = await run({ script: [{}] })
    expect(store.steps.size).toBe(0)
    expect(store.removedIds).toHaveLength(1)
    expect(events.map((e) => e.type)).toEqual(['step_start', 'done'])
  })

  it('只有 reasoning 没有正文的步骤照常落库', async () => {
    const { store } = await run({ script: [{ reasoning: '只想了一下' }] })
    expect([...store.steps.values()][0].reasoning).toBe('只想了一下')
  })
})

describe('用量计量', () => {
  it('端点报了 usage 就原样透传,标成非估算', async () => {
    const { store, events } = await run({
      script: [{ content: '答完了', usage: { prompt: 1234, completion: 56 } }]
    })
    expect([...store.steps.values()][0].usage).toEqual({
      prompt: 1234,
      completion: 56,
      estimated: false
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'usage',
        usage: { prompt: 1234, completion: 56, estimated: false }
      })
    )
  })

  it('端点没报 usage 时退回估算,输入按实际发出去的消息算', async () => {
    const probe = makeTool('结果')
    const { requests, store } = await run({
      script: [{ toolCalls: [makeCall('probe', '{}', 'u1')] }, { content: '前半' }],
      tools: { probe }
    })
    const usage = [...store.steps.values()][1].usage
    expect(usage?.estimated).toBe(true)
    // 「前半」两个汉字 → 2 token
    expect(usage?.completion).toBe(2)
    expect(usage?.prompt).toBe(estimateRequestTokens(requests[1].messages, requests[1].tools))
  })

  it('模型报错的那一步不发用量事件', async () => {
    const { events } = await run({
      stream: async () => {
        throw new Error('上下文超长')
      }
    })
    expect(events.some((e) => e.type === 'usage')).toBe(false)
  })

  it('每步各发一条 usage,带本步实际发生的裁剪计量', async () => {
    const probe = makeTool('结果')
    const { events } = await run({
      budget: { window: 4000, input: 120 },
      script: [
        { toolCalls: [makeCall('probe', '{"i":1}', 'm1')] },
        { toolCalls: [makeCall('probe', '{"i":2}', 'm2')] },
        { toolCalls: [makeCall('probe', '{"i":3}', 'm3')] },
        { content: '结束' }
      ],
      tools: { probe }
    })
    const usageEvents = events.filter((e) => e.type === 'usage')
    expect(usageEvents).toHaveLength(4)
    // 第 3 步起本轮已有 3 个可弃单元,最早的一次调用连同结果被弃掉;
    // 最后一步多了收尾提示,占掉的位置再弃一组
    expect(usageEvents.map((e) => ('context' in e ? e.context.droppedMessages : -1))).toEqual([
      0, 0, 2, 4
    ])
  })
})

describe('上下文裁剪接入循环', () => {
  it('小预算下裁掉本轮较早的步骤,锚定仍在最后', async () => {
    const probe = makeTool('结果')
    const { requests } = await run({
      budget: { window: 4000, input: 120 },
      script: [
        { toolCalls: [makeCall('probe', '{"i":1}', 'c1')] },
        { toolCalls: [makeCall('probe', '{"i":2}', 'c2')] },
        { toolCalls: [makeCall('probe', '{"i":3}', 'c3')] },
        { content: '结束' }
      ],
      tools: { probe }
    })
    expect(requests).toHaveLength(4)
    for (const request of requests) expectNoOrphanCalls(request.messages)

    // 第 1 步什么都没积累,第 3 步只留得下最新一次调用
    expect(requests[0].messages.filter((m) => m.role === 'tool')).toHaveLength(0)
    const third = requests[2].messages
    expect(third.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(['c2'])
    expect(lastContentOf(third)).toMatch(/^\[系统提醒\]/)
  })

  it('默认预算下不动本轮的工具结果', async () => {
    const probe = makeTool('结果')
    const { requests } = await run({
      script: [
        { toolCalls: [makeCall('probe', '{"i":1}', 'd1')] },
        { toolCalls: [makeCall('probe', '{"i":2}', 'd2')] },
        { content: '结束' }
      ],
      tools: { probe }
    })
    const third = requests[1].messages
    expect(third.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(['d1'])
    expect(requests[2].messages.filter((m) => m.role === 'tool')).toHaveLength(2)
  })
})

describe('摘要块在循环里固定成头部', () => {
  /** 压缩生效后的历史形态:system → 摘要 → 水位之后的原文 */
  const summarized = (): ChatCompletionMessage[] => [
    { role: 'system', content: '提示词' },
    summaryBlock('## 会话目标\n用户此前在查中牟到汝阳的路线'),
    { role: 'user', content: '继续' }
  ]

  /** 请求里出现的摘要块条数 */
  function summaryCount(messages: ChatCompletionMessage[]): number {
    return messages.filter((m) => isSummaryBlock(m)).length
  }

  it('每一步都带着它,位置固定在 system 之后:不会被逐步挪走', async () => {
    const probe = makeTool('结果')
    const { requests } = await run({
      history: summarized(),
      script: [
        { toolCalls: [makeCall('probe', '{"i":1}', 'e1')] },
        { toolCalls: [makeCall('probe', '{"i":2}', 'e2')] },
        { content: '结束' }
      ],
      tools: { probe }
    })
    expect(requests).toHaveLength(3)
    for (const request of requests) {
      expect(request.messages[0].role).toBe('system')
      expect(String(request.messages[1].content)).toContain('中牟到汝阳的路线')
      expect(summaryCount(request.messages)).toBe(1)
    }
  })

  it('预算小到必须丢历史时摘要仍然在:它就是前情本身,丢不得', async () => {
    const probe = makeTool('很长的工具结果'.repeat(60))
    const { requests } = await run({
      budget: { window: 4_000, input: 400 },
      history: summarized(),
      script: [
        { toolCalls: [makeCall('probe', '{"i":1}', 'f1')] },
        { toolCalls: [makeCall('probe', '{"i":2}', 'f2')] },
        { content: '结束' }
      ],
      tools: { probe }
    })
    for (const request of requests) {
      expect(summaryCount(request.messages)).toBe(1)
      expect(request.messages[1].role).toBe('user')
    }
    // 裁剪确实动了手(否则上面两条断言毫无意义):本轮较早的步骤被弃掉,摘要一动不动
    expect(
      requests[2].messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
    ).toEqual(['f2'])
  })

  it('摘要不算「本轮请求」:锚定引用的是水位之后那条真实提问', async () => {
    const probe = makeTool('结果')
    const { requests } = await run({
      history: summarized(),
      script: [{ toolCalls: [makeCall('probe', '{"i":1}', 'g1')] }, { content: '结束' }],
      tools: { probe }
    })
    const anchor = lastContentOf(requests[1].messages)
    expect(anchor).toMatch(/^\[系统提醒\]/)
    expect(anchor).toContain('「继续」')
    // 摘要也是 user 角色;把它当成请求来锚定,模型就会转头去续那件早已做完的事
    expect(anchor).not.toContain(SUMMARY_BLOCK_PREFIX)
  })
})

describe('run 中途压缩', () => {
  /** 压缩生效前的历史形态:system + 水位之后的那几条原文 */
  const withHistory = (): ChatCompletionMessage[] => [
    { role: 'system', content: '提示词' },
    { role: 'user', content: '查中牟到汝阳的路线' }
  ]

  /** 假的压缩注入点:记下每次收到的请求,按脚本给出结论;脚本用完即「计划拒绝」 */
  function fakeCompactor(results: RunCompactResult[]): {
    calls: RunCompactRequest[]
    run: RunCompactor
  } {
    const calls: RunCompactRequest[] = []
    return {
      calls,
      run: async (request) => {
        calls.push(request)
        return calls.length > results.length ? { compacted: false } : results[calls.length - 1]
      }
    }
  }

  /** 那条真实提问(不是摘要、不是锚定)是否还在请求里 */
  function asksOriginal(messages: ChatCompletionMessage[]): boolean {
    return messages.some(
      (m) => m.role === 'user' && !isSummaryBlock(m) && m.content === '查中牟到汝阳的路线'
    )
  }

  it('压完的下一步只带新摘要和没被覆盖的后缀:被压掉的原文不再发', async () => {
    const probe = makeTool('结果')
    const fake = fakeCompactor([{ compacted: true, summary: '已查明两条路线', coveredUnits: 1 }])
    const { requests } = await run({
      history: withHistory(),
      script: [{ toolCalls: [makeCall('probe', '{"i":1}', 'i1')] }, { content: '结束' }],
      tools: { probe },
      compaction: { summary: '', historyIds: ['m1'], run: fake.run }
    })

    const second = requests[1].messages
    expect(second[0].role).toBe('system')
    // 摘要是头部:替换旧的那份,位置钉在 system 之后
    expect(isSummaryBlock(second[1])).toBe(true)
    expect(String(second[1].content)).toContain('已查明两条路线')
    // system → 摘要 → 本轮的 assistant/tool → 锚定:那条提问换成了摘要
    expect(second.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user'])
    expect(asksOriginal(second)).toBe(false)
    // 本轮自己攒下的步骤必须留在摘要之后:续跑全靠它,裁掉就等于失忆
    expect(second[3].role).toBe('tool')
    expectNoOrphanCalls(second)
  })

  it('压缩请求带的是本轮的单元切分,边界落在已落库的行 id 上', async () => {
    const probe = makeTool('结果')
    const fake = fakeCompactor([{ compacted: false }])
    const { requests, events } = await run({
      history: withHistory(),
      script: [{ toolCalls: [makeCall('probe', '{"i":1}', 'j1')] }, { content: '结束' }],
      tools: { probe },
      compaction: { summary: '', historyIds: ['m1'], run: fake.run }
    })

    expect(fake.calls).toHaveLength(1)
    const request = fake.calls[0]
    expect(request.step).toBe(1)
    expect(request.request).toBe('查中牟到汝阳的路线')
    // 历史那条自成一个单元(带库内 id);本轮的 assistant 与它的 tool 结果同进一个单元
    expect(request.units.map((u) => u.lastId)).toEqual(['m1', 'tool-2'])
    expect(request.units.map((u) => u.messages.length)).toEqual([1, 2])
    expect(request.sizing.window).toBe(131072)
    // 还没压过:头部为空,摘要不占额度
    expect(request.sizing.summaryTokens).toBe(0)
    expect(request.sizing.fixedTokens).toBeGreaterThan(0)
    // 计划拒绝时没有模型调用、没有账目,也就没有事件可展示
    expect(events.some((e) => e.type === 'compact')).toBe(false)
    expect(asksOriginal(requests[1].messages)).toBe(true)
  })

  it('便签写明「本轮目标、进度、已执行的工具与结论」:续跑不重做已做过的事', async () => {
    const probe = makeTool('{"iso":"2026-10-12T09:00:00Z"}')
    const fake = fakeCompactor([{ compacted: false }])
    await run({
      history: withHistory(),
      script: [{ toolCalls: [makeCall('probe', '{"from":"中牟"}', 'k1')] }, { content: '结束' }],
      tools: { probe },
      compaction: { summary: '', historyIds: ['m1'], run: fake.run }
    })

    const note = fake.calls[0].note
    expect(note).toContain('- 本轮目标:查中牟到汝阳的路线')
    expect(note).toContain('第 1 步,最多 10 步')
    // 结论原文进便签:摘要里写下它,压完就不会再调一次同一个工具
    expect(note).toContain('probe({"from":"中牟"}) → 成功:{"iso":"2026-10-12T09:00:00Z"}')
  })

  it('第二次压缩拿到上一份摘要:替换语义下前情靠它合并', async () => {
    const probe = makeTool('结果')
    const fake = fakeCompactor([
      { compacted: true, summary: '第一段摘要', coveredUnits: 1 },
      { compacted: true, summary: '第一段摘要 + 此后的进展', coveredUnits: 1 }
    ])
    const { requests } = await run({
      history: withHistory(),
      script: [
        { toolCalls: [makeCall('probe', '{"i":1}', 'n1')] },
        { toolCalls: [makeCall('probe', '{"i":2}', 'n2')] },
        { content: '结束' }
      ],
      tools: { probe },
      compaction: { summary: '', historyIds: ['m1'], run: fake.run }
    })

    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[1].summary).toBe('第一段摘要')
    expect(fake.calls[1].sizing.summaryTokens).toBeGreaterThan(0)
    for (const request of requests) {
      // 换掉而不是叠加:任何一步的请求里最多只有一条摘要块
      expect(request.messages.filter((m) => isSummaryBlock(m)).length).toBeLessThanOrEqual(1)
    }
    const third = requests[2].messages
    expect(String(third[1].content)).toContain('第一段摘要 + 此后的进展')
    // 第一次压剩的那个单元也被第二次压掉了,只剩本轮最新一次调用
    expect(third.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(['n2'])
  })

  it('摘要调用失败时上下文原样继续,失败提示随事件推给界面', async () => {
    const probe = makeTool('结果')
    const fake = fakeCompactor([
      {
        compacted: false,
        usage: { prompt: 900, completion: 0, estimated: true },
        msg: '摘要调用失败:连接被拒绝'
      }
    ])
    const { requests, events } = await run({
      history: withHistory(),
      script: [{ toolCalls: [makeCall('probe', '{"i":1}', 'o1')] }, { content: '结束' }],
      tools: { probe },
      compaction: { summary: '', historyIds: ['m1'], run: fake.run }
    })

    // 半截摘要冒充完整摘要比超窗更难排查:水位没动,原文照旧带着跑
    const second = requests[1].messages
    expect(asksOriginal(second)).toBe(true)
    expect(second.filter((m) => isSummaryBlock(m))).toHaveLength(0)
    expect(events.filter((e) => e.type === 'compact')).toMatchObject([
      { type: 'compact', messageId: 'step-1', ok: false, msg: '摘要调用失败:连接被拒绝' }
    ])
  })

  it('最后一步不再压缩:下一步不给工具,压了反而把要用的结论摘没', async () => {
    const probe = makeTool('结果')
    const fake = fakeCompactor([{ compacted: true, summary: '不该出现', coveredUnits: 1 }])
    const { requests } = await run({
      maxSteps: 1,
      history: withHistory(),
      script: [{ toolCalls: [makeCall('probe', '{}', 'l1')] }, { content: '结束' }],
      tools: { probe },
      compaction: { summary: '', historyIds: ['m1'], run: fake.run }
    })

    expect(fake.calls).toHaveLength(0)
    expect(asksOriginal(requests[1].messages)).toBe(true)
  })
})
