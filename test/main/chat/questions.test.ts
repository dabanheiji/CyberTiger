import { createQuestionGate } from '../../../src/main/chat/questions'
import type { PendingQuestionDto } from '../../../src/main/chat/dto'

/** 一次提问的载荷:questionId 只用在这里,gate 的重载恢复靠它把卡片补回去 */
function request(questionId: string, conversationId = 'conv-1'): PendingQuestionDto {
  return {
    questionId,
    conversationId,
    callId: `call-${questionId}`,
    question: { question: '用哪个库', options: ['SQLite'], multiSelect: false }
  }
}

describe('提问通道的等待', () => {
  it('答案到手才 resolve,并把选项原文原样交回', async () => {
    const gate = createQuestionGate()
    const wait = gate.open('q1', request('q1'), new AbortController().signal)
    // 还没人答:这一轮就该停在等待上,不能自己往下走
    expect(gate.pending()).toBe(1)

    expect(gate.answer('q1', ['用 SQLite'])).toBe(true)
    expect(await wait).toEqual({ kind: 'answered', answers: ['用 SQLite'] })
  })

  it('空数组是一句合法的作答:用户跳过了,而不是答案丢了', async () => {
    const gate = createQuestionGate()
    const wait = gate.open('q1', request('q1'), new AbortController().signal)
    gate.answer('q1', [])
    expect(await wait).toEqual({ kind: 'answered', answers: [] })
  })

  it('中止按「本轮已中止」收场,绝不让等待永远悬着', async () => {
    const gate = createQuestionGate()
    const controller = new AbortController()
    const wait = gate.open('q1', request('q1'), controller.signal)
    controller.abort()
    expect(await wait).toEqual({ kind: 'aborted' })
    expect(gate.pending()).toBe(0)
  })

  it('中止先于提问发生时直接按已中止处理,也不登记等待', async () => {
    // run 的最后一次工具调用与用户按下停止挤在一起,这条时序真实存在
    const controller = new AbortController()
    controller.abort()
    const gate = createQuestionGate()
    expect(await gate.open('q1', request('q1'), controller.signal)).toEqual({ kind: 'aborted' })
    expect(gate.pending()).toBe(0)
  })

  it('中止后不再有人能回答:等待已经了结,条目也摘掉了', async () => {
    const gate = createQuestionGate()
    const controller = new AbortController()
    const wait = gate.open('q1', request('q1'), controller.signal)
    controller.abort()
    await wait
    expect(gate.answer('q1', ['选了它'])).toBe(false)
  })
})

describe('提问通道的超时', () => {
  it('时限一到按「没人作答」收场,等待清零', async () => {
    // 窗口关了 / 渲染层崩了时不能让 run 永久悬着,它占着的会话就再也切不了目录
    const gate = createQuestionGate(5)
    expect(await gate.open('q1', request('q1'), new AbortController().signal)).toEqual({
      kind: 'timeout'
    })
    expect(gate.pending()).toBe(0)
  })

  it('超时之后迟到的答案不再改写结果', async () => {
    const gate = createQuestionGate(5)
    await gate.open('q1', request('q1'), new AbortController().signal)
    expect(gate.answer('q1', ['来晚了'])).toBe(false)
  })

  it('超时与中止不会各 resolve 一次:先到的那个定了就定了', async () => {
    const gate = createQuestionGate(5)
    const controller = new AbortController()
    const wait = gate.open('q1', request('q1'), controller.signal)
    controller.abort()
    expect(await wait).toEqual({ kind: 'aborted' })
    // 定时器已被摘掉;再等一小会儿也不该冒出第二个结论或残留条目
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(gate.pending()).toBe(0)
  })
})

describe('提问通道的认领', () => {
  it('不认识的 id 返回 false:界面据此知道这条答案没处送', () => {
    const gate = createQuestionGate()
    expect(gate.answer('never-asked', ['算了'])).toBe(false)
  })

  it('同一个问题只接受第一次作答,重复提交不再改写结果', async () => {
    // 用户连点两次提交、或卡片收起前的迟到点击,都不该让模型收到两个矛盾的答案
    const gate = createQuestionGate()
    const wait = gate.open('q1', request('q1'), new AbortController().signal)
    expect(gate.answer('q1', ['第一次'])).toBe(true)
    expect(gate.answer('q1', ['第二次'])).toBe(false)
    expect(await wait).toEqual({ kind: 'answered', answers: ['第一次'] })
  })

  it('两个提问可以同时在等,答案按 id 各自认领', async () => {
    const gate = createQuestionGate()
    const first = gate.open('q1', request('q1'), new AbortController().signal)
    const second = gate.open('q2', request('q2'), new AbortController().signal)
    gate.answer('q2', ['乙'])
    expect(await second).toEqual({ kind: 'answered', answers: ['乙'] })
    // 第一个仍在等:q2 的答案不能顺手把 q1 也了结
    expect(gate.pending()).toBe(1)
    gate.answer('q1', ['甲'])
    expect(await first).toEqual({ kind: 'answered', answers: ['甲'] })
  })

  it('一次提问了结后不影响另一条的中止', async () => {
    const gate = createQuestionGate()
    const a = new AbortController()
    const b = new AbortController()
    const waitA = gate.open('q1', request('q1'), a.signal)
    const waitB = gate.open('q2', request('q2'), b.signal)
    b.abort()
    expect(await waitB).toEqual({ kind: 'aborted' })
    expect(gate.pending()).toBe(1)
    // 摘掉 q2 时不能把 q1 的监听也解掉:它还在等真实答案
    gate.answer('q1', ['甲'])
    expect(await waitA).toEqual({ kind: 'answered', answers: ['甲'] })
  })

  it('多个提问全部中止后等待清零,会话不会被留在「有进行中的 run」状态', async () => {
    // 切换工作空间与手动压缩都要求无进行中 run,残留的等待会把这两条路一起堵死
    const gate = createQuestionGate()
    const first = new AbortController()
    const second = new AbortController()
    const waitA = gate.open('q1', request('q1'), first.signal)
    const waitB = gate.open('q2', request('q2'), second.signal)
    first.abort()
    second.abort()
    expect(await Promise.all([waitA, waitB])).toEqual([{ kind: 'aborted' }, { kind: 'aborted' }])
    expect(gate.pending()).toBe(0)
  })
})

describe('提问通道的重载恢复', () => {
  it('list 返回还在等的载荷:渲染层 Cmd+R 后靠它把卡片补回来', async () => {
    const gate = createQuestionGate()
    const wait = gate.open('q1', request('q1', 'conv-42'), new AbortController().signal)
    expect(gate.list()).toEqual([request('q1', 'conv-42')])
    gate.answer('q1', ['甲'])
    await wait
    // 了结之后不再出现在等待表里:否则重载一次就会补出一张再也送不出去的卡片
    expect(gate.list()).toEqual([])
  })

  it('两个提问各带自己的会话与调用 id,重载后能分别挂回各自的会话', async () => {
    const gate = createQuestionGate()
    const a = gate.open('q1', request('q1', 'conv-a'), new AbortController().signal)
    const b = gate.open('q2', request('q2', 'conv-b'), new AbortController().signal)
    expect(gate.list().map((item) => [item.conversationId, item.callId])).toEqual([
      ['conv-a', 'call-q1'],
      ['conv-b', 'call-q2']
    ])
    gate.answer('q1', ['甲'])
    gate.answer('q2', ['乙'])
    await Promise.all([a, b])
  })
})

describe('提问通道的了结顺序', () => {
  it('答案与中止同时到达时以先到的为准,后到的一侧不再改结果', async () => {
    // 用户按下提交的同一个瞬间 run 被中止:模型收到的应是用户真的选了什么,而不是中止占位
    const gate = createQuestionGate()
    const controller = new AbortController()
    const wait = gate.open('q1', request('q1'), controller.signal)
    gate.answer('q1', ['选了它'])
    controller.abort()
    expect(await wait).toEqual({ kind: 'answered', answers: ['选了它'] })
  })
})
