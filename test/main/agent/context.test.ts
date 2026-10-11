import {
  DEFAULT_CONTEXT_WINDOW,
  OUTPUT_RESERVE,
  budgetFor,
  planContext,
  type ContextBudget
} from '../../../src/main/agent/context'
import type { ChatCompletionMessage } from '../../../src/main/chat/llm'

/**
 * 造长度可预测的消息:正文用 1 个标记汉字 + 补足的「中」,
 * 于是该条消息的估算值 = 4(每条固定开销)+ 正文的 token 数,断言能算得准。
 */
function msg(
  role: 'system' | 'user' | 'assistant',
  marker: string,
  tokens: number
): ChatCompletionMessage {
  return { role, content: marker + '中'.repeat(Math.max(0, tokens - 1)) }
}

/** 正文首字就是标记,用来判断哪些消息被留下了、顺序如何 */
function markers(messages: ChatCompletionMessage[]): string[] {
  return messages.map((m) => contentOf(m).slice(0, 1))
}

/** assistant 发起的一次调用,固定 14 token(4 + 8 + 名字 1 + 参数 1) */
function callOf(callId: string): ChatCompletionMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: callId, type: 'function', function: { name: 'p', arguments: '{}' } }]
  }
}

function toolRow(callId: string, marker: string, tokens: number): ChatCompletionMessage {
  return { role: 'tool', tool_call_id: callId, content: marker + '中'.repeat(tokens - 1) }
}

function callIds(messages: ChatCompletionMessage[]): string[] {
  return messages.flatMap((m) =>
    m.role === 'assistant' ? (m.tool_calls?.map((c) => c.id) ?? []) : []
  )
}

function answeredIds(messages: ChatCompletionMessage[]): string[] {
  return messages.flatMap((m) => (m.role === 'tool' ? [m.tool_call_id] : []))
}

/** 取正文;多模态数组与 null 都按空串 */
function contentOf(message: ChatCompletionMessage | undefined): string {
  return typeof message?.content === 'string' ? message.content : ''
}

/** 各次调用的参数原文(SDK 的调用有 function / custom 两支,这里只走 function) */
function argumentsOf(messages: ChatCompletionMessage[]): string[] {
  return messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) =>
      (m.tool_calls ?? []).map((call) => (call.type === 'function' ? call.function.arguments : ''))
    )
}

/** 裁剪最容易制造「有调用无响应」的孤儿行,每条裁剪结果都必须过这一关 */
function expectNoOrphanCalls(messages: ChatCompletionMessage[]): void {
  expect(callIds(messages).filter((id) => !answeredIds(messages).includes(id))).toEqual([])
}

function budget(input: number): ContextBudget {
  return { window: input + OUTPUT_RESERVE, input }
}

describe('budgetFor', () => {
  it('缺省按 32k 兜底窗口留出输出预留与安全边界', () => {
    expect(budgetFor()).toEqual({ window: DEFAULT_CONTEXT_WINDOW, input: 23_200 })
  })

  it('窗口不大于输出预留时退回兜底值,不算出负额度', () => {
    expect(budgetFor(4000)).toEqual(budgetFor())
    expect(budgetFor(0)).toEqual(budgetFor())
    expect(budgetFor(Number.NaN)).toEqual(budgetFor())
  })

  it('窗口小到扣不出输出预留时按 0 算,不给负额度', () => {
    // 设置里的最小值是 4096:4096 × 85% 本来就小于 4000 的输出预留
    expect(budgetFor(4096).input).toBe(0)
  })

  it('大窗口按 85% 折算再减掉输出预留', () => {
    expect(budgetFor(128_000)).toEqual({ window: 128_000, input: 104_800 })
  })
})

describe('planContext 在预算内', () => {
  it('塞得下就逐字不变,计量也全是 0', () => {
    const system = msg('system', 'S', 5)
    const history = [msg('user', '甲', 10), msg('assistant', '乙', 10)]
    const plan = planContext({ system, history, tools: [], budget: budget(1000) })

    expect(plan.messages).toEqual([system, ...history])
    expect(plan.meter).toEqual({
      budget: 1000,
      droppedTurns: 0,
      droppedMessages: 0,
      shrunkMessages: 0
    })
  })

  it('不修改调用方传入的消息', () => {
    const history = [msg('user', '甲', 10)]
    planContext({ history, tools: [], budget: budget(50) })
    expect(history).toHaveLength(1)
    expect(history[0].content).toBe('甲' + '中'.repeat(9))
  })
})

describe('planContext 丢整轮', () => {
  it('丢最旧的连续若干轮,system 与循环控制消息原位不动', () => {
    const system = msg('system', 'S', 10)
    const pinned = [msg('user', '锚', 20)]
    // 4 轮,每轮 108 token;固定部分 = system 14 + 锚定 24 + 回复预留 3
    const history = [
      msg('user', '甲', 50),
      msg('assistant', '乙', 50),
      msg('user', '丙', 50),
      msg('assistant', '丁', 50),
      msg('user', '戊', 50),
      msg('assistant', '己', 50),
      msg('user', '庚', 50),
      msg('assistant', '辛', 50)
    ]
    const plan = planContext({ system, history, pinned, tools: [], budget: budget(41 + 216) })

    expect(markers(plan.messages)).toEqual(['S', '戊', '己', '庚', '辛', '锚'])
    expect(plan.meter).toMatchObject({ droppedTurns: 2, droppedMessages: 0, shrunkMessages: 0 })
    expectNoOrphanCalls(plan.messages)
  })

  it('一次调用与它的工具结果同进同出', () => {
    // 单轮内 4 个单元:请求(54)+ c1 调用与结果(58)+ c2 调用与结果(58)+ 最新回答(54)
    const history = [
      msg('user', '甲', 50),
      callOf('c1'),
      toolRow('c1', '丙', 40),
      callOf('c2'),
      toolRow('c2', '丁', 40),
      msg('assistant', '乙', 50)
    ]
    // 只够放下请求 + 最新两步(200)
    const plan = planContext({ history, tools: [], budget: budget(3 + 200) })

    expect(markers(plan.messages)).toEqual(['甲', '', '丁', '乙'])
    expect(callIds(plan.messages)).toEqual(['c2'])
    expect(answeredIds(plan.messages)).toEqual(['c2'])
    expect(plan.meter.droppedMessages).toBe(2)
    expectNoOrphanCalls(plan.messages)
  })

  it('只剩请求与最新回答时也不留半截工具链', () => {
    const history = [
      msg('user', '甲', 50),
      callOf('c1'),
      toolRow('c1', '丙', 40),
      callOf('c2'),
      toolRow('c2', '丁', 40),
      msg('assistant', '乙', 50)
    ]
    // 110 只够请求 + 最新回答,轮内较早的两个单元全部弃掉
    const plan = planContext({ history, tools: [], budget: budget(3 + 110) })

    expect(markers(plan.messages)).toEqual(['甲', '乙'])
    expect(plan.meter.droppedMessages).toBe(4)
    expectNoOrphanCalls(plan.messages)
  })
})

describe('planContext 压到底仍然超预算', () => {
  it('带着超限发出去,而不是静默改坏内容', () => {
    const system = msg('system', 'S', 50)
    const pinned = [msg('user', '锚', 10)]
    const history = [msg('user', '甲', 100), msg('assistant', '乙', 100), msg('user', '丙', 100)]
    const plan = planContext({ system, history, pinned, tools: [], budget: budget(5) })

    // 额度被压到 0,但请求原文、system 与锚定都还在原位
    expect(markers(plan.messages)).toEqual(['S', '丙', '锚'])
    expect(plan.messages[1].content).toBe('丙' + '中'.repeat(99))
    expect(plan.meter.droppedTurns).toBe(1)
  })

  it('最新一轮只有自己一条消息时无从弃起,整轮保留', () => {
    const history = [msg('user', '甲', 100), msg('user', '乙', 100)]
    const plan = planContext({ history, tools: [], budget: budget(10) })

    expect(markers(plan.messages)).toEqual(['乙'])
    expect(plan.messages[0].content).toBe('乙' + '中'.repeat(99))
    expect(plan.meter).toMatchObject({ droppedTurns: 1, droppedMessages: 0, shrunkMessages: 0 })
  })
})

describe('planContext 缩写超长消息', () => {
  it('只压 content,不动 tool_calls 的参数', () => {
    const long = {
      ...callOf('c1'),
      content: '长' + '中'.repeat(3999)
    } as ChatCompletionMessage
    const history = [
      msg('user', '甲', 50),
      long,
      toolRow('c1', '丙', 40),
      msg('user', '乙', 10),
      msg('assistant', '丙', 10)
    ]
    // 1250:整轮 4116 塞不下,压到 ~1216 之后连同最新一轮刚好塞得下
    const plan = planContext({ history, tools: [], budget: budget(3 + 1250) })

    const shrunk = plan.messages.find((m) => contentOf(m).includes('省略'))
    expect(shrunk).toBeDefined()
    expect(contentOf(shrunk).length).toBeLessThan(1200)
    // 参数原文一个字节都没改:截断 JSON 会在回放时报一个更难排查的错
    expect(argumentsOf(plan.messages)).toEqual(['{}'])
    expect(plan.meter).toMatchObject({ droppedTurns: 0, shrunkMessages: 1 })
    expectNoOrphanCalls(plan.messages)
  })

  it('省略标记是陈述句,不出现祈使语气', () => {
    const long = { ...callOf('c1'), content: '长' + '中'.repeat(3999) } as ChatCompletionMessage
    const history = [msg('user', '甲', 50), long, toolRow('c1', '丙', 40)]
    const plan = planContext({
      history,
      pinned: [msg('user', '锚', 10)],
      tools: [],
      budget: budget(3 + 200)
    })

    const content = contentOf(plan.messages.find((m) => contentOf(m).includes('省略')))
    expect(content).toBeTruthy()
    // 「如需该信息请重新调用工具」这类文案会让模型转头重跑上一轮的工具,整轮跑偏
    expect(content).not.toMatch(/请|如需|建议|可以|应当/)
  })
})
