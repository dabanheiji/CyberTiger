import {
  ASK_USER_TOOL_NAME,
  createAskUserTool,
  describeAnswer,
  type AskUserHandler
} from '../../../src/main/agent/ask'
import { createToolRunner } from '../../../src/main/tools/registry'
import { runAgent, MAIN_AGENT_MAX_STEPS } from '../../../src/main/agent/loop'
import type { AskUserAnswer, AskUserQuestion } from '../../../src/main/chat/dto'
import {
  makeCall,
  makeEmit,
  makeModel,
  makeStore,
  rootScope,
  type ModelStep
} from '../../helpers/agent'

/** 记下的每一次提问,答案由测试决定何时给出 */
interface RecordedAsk {
  question: AskUserQuestion
  callId: string
  answer: (value: AskUserAnswer) => void
}

/**
 * 假的提问通道:不走渲染层,但保持「拿到答案才 resolve」这个真实形状 ——
 * run 是否真的停在一次提问上,只有靠这种可控的等待才能断言。
 * 不传 `auto` 就留在等待中,由测试自己决定何时给出答案。
 */
function makeAsker(auto?: AskUserAnswer): { handler: AskUserHandler; asks: RecordedAsk[] } {
  const asks: RecordedAsk[] = []
  const handler: AskUserHandler = (question, callId) =>
    new Promise<AskUserAnswer>((resolve) => {
      asks.push({ question, callId, answer: resolve })
      if (auto !== undefined) resolve(auto)
    })
  return { handler, asks }
}

/**
 * 单独跑一次工具调用(走真实 runner,参数校验与错误转译一并覆盖)。
 * 通道立刻给出 `auto`,所以这里能拿到「问出去的那份问题」而不必等答案。
 */
async function callTool(
  args: Record<string, unknown>,
  callId = 'call-1',
  auto: AskUserAnswer = []
): Promise<{ ok: boolean; result: string; ask: RecordedAsk }> {
  const { handler, asks } = makeAsker(auto)
  const tool = createAskUserTool(handler)
  const res = await createToolRunner([tool]).execute(ASK_USER_TOOL_NAME, JSON.stringify(args), {
    callId
  })
  return { ...res, ask: asks[asks.length - 1] }
}

describe('ask_user 的参数归一', () => {
  it('纯字符串候选原样保留,顺序就是界面显示的顺序', async () => {
    const { ok, ask } = await callTool({
      question: '用哪个存储',
      options: ['SQLite', 'JSON 文件']
    })
    expect(ok).toBe(true)
    expect(ask.question.options).toEqual(['SQLite', 'JSON 文件'])
    expect(ask.question.multiSelect).toBe(false)
  })

  it('模型给 { label, description } 形状时也认:它的训练数据里两种写法都有', async () => {
    const { ask } = await callTool({
      question: '要不要加索引',
      options: [
        { label: '加', description: '查询快' },
        { label: '不加', description: '写入快' }
      ]
    })
    // 界面上一项就是要直接当答案的那句话,说明文字不占位
    expect(ask.question.options).toEqual(['加', '不加'])
  })

  it('丢掉空白项与重复项:两条一模一样的 Radio 点了也不知道选了哪条', async () => {
    const { ask } = await callTool({
      question: '怎么命名',
      options: ['  ', 'kebab-case', 'kebab-case', 'snake_case', '', 'kebab-case']
    })
    expect(ask.question.options).toEqual(['kebab-case', 'snake_case'])
  })

  it('候选超过上限只留前面几个,再多也只是把卡片变成一屏', async () => {
    const { ask } = await callTool({
      question: '选一个',
      options: Array.from({ length: 10 }, (_, i) => `选项 ${i + 1}`)
    })
    expect(ask.question.options).toHaveLength(6)
    expect(ask.question.options[5]).toBe('选项 6')
  })

  it('options 缺失或不是数组时按「没有候选」处理,而不是报错', async () => {
    // 模型有时会只写 question 就发出来;卡片照样能弹,用户自己输入就是答案
    const missing = await callTool({ question: '你想怎么称呼这个模块' })
    expect(missing.ok).toBe(true)
    expect(missing.ask.question.options).toEqual([])
    const wrongType = await callTool({ question: '换个问法', options: 'SQLite' })
    expect(wrongType.ask.question.options).toEqual([])
  })

  it('缺 question 时拒绝执行,把原因说清交给模型自纠', async () => {
    const { handler, asks } = makeAsker()
    const tool = createAskUserTool(handler)
    const res = await createToolRunner([tool]).execute(
      ASK_USER_TOOL_NAME,
      JSON.stringify({ options: ['甲', '乙'] }),
      { callId: 'call-1' }
    )
    expect(res.ok).toBe(false)
    expect(res.result).toContain('question')
    // 问题都没问出口,不该有卡片也不该有等待
    expect(asks).toHaveLength(0)
  })

  it('multiSelect 只认真正的 true,字符串 "false" 不判成多选', async () => {
    expect(
      (await callTool({ question: '选哪些', options: ['甲', '乙'] })).ask.question.multiSelect
    ).toBe(false)
    const str = await callTool({ question: '选哪些', options: ['甲', '乙'], multiSelect: 'false' })
    expect(str.ask.question.multiSelect).toBe(false)
    const on = await callTool({ question: '选哪些', options: ['甲', '乙'], multiSelect: true })
    expect(on.ask.question.multiSelect).toBe(true)
  })

  it('提问通道拿到的是本次调用的 callId:渲染层靠它在结果到手时收起卡片', async () => {
    const { ask } = await callTool({ question: '用哪个库', options: ['甲'] }, 'call-42')
    expect(ask.callId).toBe('call-42')
  })

  it('工具结果就是给模型看的作答文本,通道给出的形状原样翻译', async () => {
    const { result } = await callTool({ question: '用哪个库', options: ['SQLite'] }, 'c', [
      'SQLite'
    ])
    expect(result).toBe('用户的回答:「SQLite」')
  })
})

describe('ask_user 的 schema 与描述', () => {
  it('question 与 options 必填,multiSelect 可省(缺省单选)', () => {
    const tool = createAskUserTool(makeAsker().handler)
    expect(tool.name).toBe(ASK_USER_TOOL_NAME)
    expect(tool.parameters.required).toEqual(['question', 'options'])
    expect(Object.keys(tool.parameters.properties as object)).toEqual([
      'question',
      'options',
      'multiSelect'
    ])
  })

  it('描述里写明界面自带自由输入位置:候选项不必自己加「其他」', () => {
    const tool = createAskUserTool(makeAsker().handler)
    // 模型若自己列一项「其他」,用户在那儿写的东西会被当成一个普通选项
    expect(tool.description).toContain('自己输入')
    expect(tool.description).toContain('不必自己加')
  })

  it('描述不含「请重新调用」这类祈使:重复提问由本轮去重拦下,不靠文案催促', () => {
    const tool = createAskUserTool(makeAsker().handler)
    expect(tool.description).not.toMatch(/请重新调用|必须重新调用|每次.*调用/)
  })

  it('描述说明一次只问一件事:嵌套两层数组的 schema 对小模型太难', () => {
    expect(createAskUserTool(makeAsker().handler).description).toContain('一次调用只问一个问题')
  })
})

describe('describeAnswer:用户作答写成给模型看的文本', () => {
  it('选中的项用陈述句列出,多选时逐项用顿号分开', () => {
    expect(describeAnswer(['SQLite'])).toBe('用户的回答:「SQLite」')
    expect(describeAnswer(['加索引', '分表'])).toBe('用户的回答:「加索引」、「分表」')
  })

  it('空数组说「用户跳过了」,不写成错误', () => {
    // 跳过是合法选择:模型据此按自己的判断继续,而不是以为工具坏了
    expect(describeAnswer([])).toContain('跳过了')
  })

  it('null 说「本轮已中止,没有拿到回答」,模型不会把它当成空答案继续编', () => {
    expect(describeAnswer(null)).toContain('已中止')
  })

  it('前后空白与空白项不产出空的「『』」', () => {
    expect(describeAnswer([' 甲 ', '', '  '])).toBe('用户的回答:「甲」')
  })
})

/**
 * 用真实的 runner 起一次 run:提问工具、循环、落库与事件一起过。
 * run 会停在 pending 的那次提问上,所以返回的进行中 Promise 由调用方决定何时 await。
 *
 * 这里的通道照 `chat/questions.ts` 的语义实现中止分支(signal 一到就按「没拿到回答」收场),
 * 因为生产代码的中止逻辑住在 service 闭包住的 gate 里,而 service 要 DB、进不了单测。
 */
function startRun(
  script: ModelStep[],
  signal: AbortSignal
): {
  model: ReturnType<typeof makeModel>
  store: ReturnType<typeof makeStore>
  collected: ReturnType<typeof makeEmit>['collected']
  asks: RecordedAsk[]
  running: Promise<Awaited<ReturnType<typeof runAgent>>>
} {
  const asks: RecordedAsk[] = []
  const handler: AskUserHandler = (question, callId) =>
    new Promise<AskUserAnswer>((resolve) => {
      const settle = (answer: AskUserAnswer): void => {
        signal.removeEventListener('abort', onAbort)
        resolve(answer)
      }
      const onAbort = (): void => settle(null)
      asks.push({ question, callId, answer: settle })
      if (signal.aborted) resolve(null)
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  const model = makeModel(script)
  const store = makeStore()
  const { emit, collected } = makeEmit()
  const running = runAgent({
    scope: rootScope(),
    baseUrl: 'https://model.test/v1',
    model: 'test-model',
    signal,
    history: [{ role: 'user', content: '帮我决定存储方案' }],
    runner: createToolRunner([createAskUserTool(handler)]),
    maxSteps: MAIN_AGENT_MAX_STEPS,
    store,
    emit,
    stream: model.stream
  })
  return { model, store, collected, asks, running }
}

/**
 * 等到第 n 次提问真的发出来。
 * loop 到工具之间隔着好几层 await(模型调用、落库、事件),排干微任务不一定够,
 * 而这里要等的正是「run 停在提问上」这件事,所以让出事件循环再查。
 */
async function waitAsked(asks: RecordedAsk[], n = 1): Promise<void> {
  for (let i = 0; i < 50 && asks.length < n; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  if (asks.length < n) throw new Error(`第 ${n} 次提问没有发出来`)
}

describe('run 阻塞在提问上', () => {
  it('答案到手前没有工具结果,也没有下一步:一次提问真的把这一轮停住', async () => {
    const { collected, asks, running } = startRun(
      [
        {
          toolCalls: [
            makeCall('ask_user', '{"question":"用哪个库","options":["SQLite","JSON"]}', 'q1')
          ]
        },
        { content: '那就用 SQLite' }
      ],
      new AbortController().signal
    )

    await waitAsked(asks)
    // 问出去的就是模型那一次调用的内容,callId 一并交给通道(渲染层靠它收起卡片)
    expect(asks[0]).toMatchObject({
      callId: 'q1',
      question: { question: '用哪个库', options: ['SQLite', 'JSON'], multiSelect: false }
    })
    // 提问已发出,但那一次调用还没有结果:run 就停在这里
    expect(collected.of('tool_result')).toHaveLength(0)

    asks[0].answer(['SQLite'])
    await running
    expect(collected.of('tool_result')[0].result).toBe('用户的回答:「SQLite」')
  })

  it('答案作为 tool 消息进下一步请求,模型据此继续而非重问', async () => {
    const { model, asks, running } = startRun(
      [
        {
          toolCalls: [makeCall('ask_user', '{"question":"用哪个库","options":["SQLite"]}', 'q1')]
        },
        { content: '好的,用 SQLite' }
      ],
      new AbortController().signal
    )
    await waitAsked(asks)
    asks[0].answer(['SQLite'])
    await running

    const toolMessage = model.requests[1].messages.find((m) => m.role === 'tool')
    expect(toolMessage?.content).toBe('用户的回答:「SQLite」')
    expect(toolMessage?.tool_call_id).toBe('q1')
  })

  it('同一轮里重复提出同一问题只问一次,第二次直接复用第一次的答案', async () => {
    // 模型有时会把刚问过的事再问一遍;若每次都弹卡片,用户会被同一个问题打断两次
    const { collected, asks, running } = startRun(
      [
        {
          toolCalls: [
            makeCall('ask_user', '{"question":"用哪个库","options":["SQLite"]}', 'q1'),
            makeCall('ask_user', '{"options":["SQLite"],"question":"用哪个库"}', 'q2')
          ]
        },
        { content: '定了' }
      ],
      new AbortController().signal
    )
    await waitAsked(asks)
    // 参数键序不同也算同一个问题:去重的 key 会把 JSON 排序后比对。
    // 只问一次 = 通道只被叫一次,第二次不再弹卡片,用户不会被同一个问题打断两遍。
    expect(asks).toHaveLength(1)
    asks[0].answer(['SQLite'])
    await running

    const results = collected.of('tool_result')
    expect(results.map((e) => e.result)).toEqual(['用户的回答:「SQLite」', '用户的回答:「SQLite」'])
    expect(results.map((e) => e.reused)).toEqual([false, true])
  })

  it('提问期间用户按下停止:这次等待按没拿到回答收场,不给模型留孤儿调用', async () => {
    const controller = new AbortController()
    const { store, collected, asks, running } = startRun(
      [{ toolCalls: [makeCall('ask_user', '{"question":"用哪个库","options":["SQLite"]}', 'q1')] }],
      controller.signal
    )
    await waitAsked(asks)
    controller.abort()
    // gate 挂在 run 的同一个 signal 上,不需要 loop 额外配合就能收场
    const result = await running
    expect(result.aborted).toBe(true)
    expect(collected.of('tool_result')[0].result).toContain('已中止')
    // 已落库的 assistant 行带着那次调用,必须有对应的 tool 行,否则下一轮回放 400
    expect(store.toolRows.map((r) => r.toolCallId)).toEqual(['q1'])
  })
})
