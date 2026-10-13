import type { ChatCompletionMessage } from '../chat/llm'
import { estimateMessageTokens } from '../tokens/estimate'

/**
 * 历史消息的分组单位。
 *
 * 「按条裁剪」是本项目踩过一次的坑:一次 assistant 输出和它发起的 tool 结果被拆开,
 * 请求里就出现「有 tool_calls 无响应」的孤儿行,严格的 OpenAI 兼容端点直接 400。
 * 所以丢弃、缩写、摘要的边界都只能落在这些组上,让孤儿行在**结构上**无法产生 ——
 * 不靠裁剪时小心配对。上下文裁剪(agent/context.ts)与上下文压缩(agent/compact.ts)共用这一份。
 */

/** 一轮:一条 user 消息连同它之后的所有 assistant / tool 行 */
export interface Turn {
  messages: ChatCompletionMessage[]
  tokens: number
}

/** 一轮内可整体弃留的最小单元:一次 assistant 输出 + 它发起的全部工具结果 */
export interface TurnUnit {
  messages: ChatCompletionMessage[]
  tokens: number
}

/** 分组结果的通用形状:一组条目 + 它们的总 token 数 */
export interface UnitOf<T> {
  items: T[]
  tokens: number
}

/** 带库内 id 的消息:摘要的水位要落在具体某条消息上 */
export interface IdentifiedMessage {
  id: string
  message: ChatCompletionMessage
}

/** 一条消息能否开启新单元:它自己要么是提问要么是输出 */
function startsUnit(role: string): boolean {
  return role === 'assistant' || role === 'user'
}

/**
 * 分组规则的唯一实现:遇到 user / assistant 就起一个新单元,其余条目并入当前单元。
 * 裁剪要按裸消息分组,摘要要按「消息 + 库内 id」分组(水位得有个落点),
 * 两者必须切在同一处 —— 所以这里参数化 role 与长度,而不是再写一遍规则。
 */
function groupBy<T>(
  items: T[],
  roleOf: (item: T) => string,
  sizeOf: (item: T) => number
): UnitOf<T>[] {
  const units: UnitOf<T>[] = []
  for (const item of items) {
    if (startsUnit(roleOf(item)) || units.length === 0) {
      units.push({ items: [item], tokens: sizeOf(item) })
      continue
    }
    const last = units[units.length - 1]
    last.items.push(item)
    last.tokens += sizeOf(item)
  }
  return units
}

/** 一组消息的估算 token 数;估算口径见 tokens/estimate.ts */
export function tokensOf(messages: ChatCompletionMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
}

/**
 * 按 user 消息切轮。
 * 发起调用的 assistant 行和它的 tool 结果必然落在同一轮里,于是「整轮丢弃」结构上
 * 不可能产生孤儿 tool_calls。
 */
export function groupTurns(messages: ChatCompletionMessage[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null
  for (const message of messages) {
    if (current === null || message.role === 'user') {
      current = { messages: [], tokens: 0 }
      turns.push(current)
    }
    current.messages.push(message)
    current.tokens += estimateMessageTokens(message)
  }
  return turns
}

/**
 * 把一轮拆成可弃单元。
 * 首条 user 消息(用户的原始请求)单独成单元且永不弃;此后每个 assistant 输出
 * 带着它自己的工具结果成一个单元 —— 弃就弃整个,不会出现「有调用无响应」。
 */
export function splitUnits(turn: Turn): TurnUnit[] {
  return groupBy(
    turn.messages,
    (m) => m.role,
    (m) => estimateMessageTokens(m)
  ).map((unit) => ({ messages: unit.items, tokens: unit.tokens }))
}

/**
 * 与 splitUnits 同一条边界规则,但条目带着库内 id。
 * 摘要段的水位必须写「覆盖到的最后一条消息」,所以分组时不能把 id 弄丢。
 */
export function splitIdentifiedUnits(items: IdentifiedMessage[]): UnitOf<IdentifiedMessage>[] {
  return groupBy(
    items,
    (item) => item.message.role,
    (item) => estimateMessageTokens(item.message)
  )
}
