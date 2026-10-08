import { MAIN_AGENT_MAX_STEPS, runAgent, type RunAgentParams } from '../../../src/main/agent/loop'
import { STEP_LIMIT_PROMPT } from '../../../src/main/agent/prompt'
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
    stream: options.stream ?? model.stream
  })
  return { result, requests: model.requests, store, events: collected.events }
}

/** 内容末条消息,锚定与循环控制都追加在这里 */
function lastContentOf(messages: ChatCompletionMessage[]): string {
  const last = messages[messages.length - 1]
  return typeof last?.content === 'string' ? last.content : ''
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
    // reasoning 与 content 分开推流:1 条思考 + 正文被拆成 2 条
    expect(events.map((e) => e.type)).toEqual(['step_start', 'delta', 'delta', 'delta', 'done'])
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

  it('工具执行到一半中止会留下没有响应的 tool_calls(已知缺陷)', async () => {
    const controller = new AbortController()
    const probe = makeTool(() => {
      controller.abort()
      return '第一个结果'
    })
    const first = makeCall('probe', '{"i":1}', 'a1')
    const second = makeCall('probe', '{"i":2}', 'a2')
    const { store } = await run({
      signal: controller.signal,
      script: [{ toolCalls: [first, second] }, { content: '不该走到这里' }],
      tools: { probe }
    })
    const step = [...store.steps.values()][0]
    expect(step.calls.map((c) => c.id)).toEqual([first.id, second.id])
    // assistant 行带两个调用,但只有第一个有 tool 行 → 下一轮回放会违反 OpenAI 协议
    expect(store.toolRows.map((r) => r.toolCallId)).toEqual([first.id])
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
