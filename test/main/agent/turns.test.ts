import type { ChatCompletionMessage } from '../../../src/main/chat/llm'
import {
  groupTurns,
  splitIdentifiedUnits,
  splitUnits,
  tokensOf,
  type IdentifiedMessage,
  type Turn
} from '../../../src/main/agent/turns'

/**
 * 分组规则的唯一实现,裁剪(agent/context.ts)与摘要(agent/compact.ts)共用。
 * 这里的用例只钉「边界」:两边切出的组必须一模一样 —— 一旦摘要按 A 边界推进水位、
 * 裁剪按 B 边界弃留,水位就会落在裁剪不认识的位置上。
 */

type Role = 'user' | 'assistant' | 'tool'

function msg(role: Role, marker: string): ChatCompletionMessage {
  if (role === 'tool') return { role: 'tool', tool_call_id: marker, content: marker }
  if (role === 'assistant' && marker === 'call') {
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }]
    }
  }
  return { role, content: marker } as ChatCompletionMessage
}

function rolesOf(unit: { messages: ChatCompletionMessage[] }): Role[] {
  return unit.messages.map((m) => m.role as Role)
}

describe('groupTurns 按 user 切轮', () => {
  it('一条 user 起一轮,其后的 assistant / tool 都并进这一轮', () => {
    const turns = groupTurns([
      msg('user', '问'),
      msg('assistant', 'call'),
      msg('tool', 'c1'),
      msg('assistant', '答'),
      msg('user', '再问')
    ])
    expect(turns.map(rolesOf)).toEqual([['user', 'assistant', 'tool', 'assistant'], ['user']])
  })

  it('开头没有 user 时也从第一条起组:裸 assistant 不会被丢掉', () => {
    expect(
      groupTurns([msg('assistant', '答'), msg('user', '问')]).map((t) => t.messages.length)
    ).toEqual([1, 1])
  })

  it('空历史得到空数组,而不是一个空轮', () => {
    expect(groupTurns([])).toEqual([])
  })

  it('轮的 tokens 是内部消息之和,与 tokensOf 同口径', () => {
    const messages = [msg('user', '问'), msg('assistant', '答')]
    expect(groupTurns(messages)[0].tokens).toBe(tokensOf(messages))
  })
})

describe('splitUnits 把一轮拆成可整体弃留的单元', () => {
  const turn: Turn = groupTurns([
    msg('user', '问'),
    msg('assistant', 'call'),
    msg('tool', 'c1'),
    msg('assistant', '答')
  ])[0]

  it('一次调用连同它的工具结果同属一个单元', () => {
    expect(splitUnits(turn).map(rolesOf)).toEqual([['user'], ['assistant', 'tool'], ['assistant']])
  })

  it('首条 user 单独成单元:用户的原始请求永不参与弃留', () => {
    expect(splitUnits(turn)[0].messages).toEqual([msg('user', '问')])
  })

  it('单元 tokens 之和等于整轮 tokens:拆分不改变总量', () => {
    expect(splitUnits(turn).reduce((sum, u) => sum + u.tokens, 0)).toBe(turn.tokens)
  })
})

describe('splitIdentifiedUnits 与 splitUnits 切在同一处', () => {
  const messages: ChatCompletionMessage[] = [
    msg('user', '问'),
    msg('assistant', 'call'),
    msg('tool', 'c1'),
    msg('assistant', '答'),
    msg('user', '再问'),
    msg('assistant', '答2')
  ]
  const items: IdentifiedMessage[] = messages.map((message, index) => ({
    id: `m${index}`,
    message
  }))

  it('分组形状与 tokens 完全一致:同一条规则的两个入口', () => {
    const byMessage = splitUnits({ messages, tokens: 0 })
    const byId = splitIdentifiedUnits(items)
    expect(byId.map((u) => u.items.length)).toEqual(byMessage.map((u) => u.messages.length))
    expect(byId.map((u) => u.tokens)).toEqual(byMessage.map((u) => u.tokens))
  })

  it('id 随消息一起保留:水位能落在每组最后那条消息上', () => {
    expect(splitIdentifiedUnits(items).map((u) => u.items[u.items.length - 1].id)).toEqual([
      'm0',
      'm2',
      'm3',
      'm4',
      'm5'
    ])
  })

  it('tool 行从不自己起组:它只跟在发起它的 assistant 后面', () => {
    for (const unit of splitIdentifiedUnits(items)) {
      const roles = unit.items.map((item) => item.message.role)
      expect(roles[0]).not.toBe('tool')
      if (!roles.includes('tool')) continue
      expect(roles[0]).toBe('assistant')
    }
  })
})
