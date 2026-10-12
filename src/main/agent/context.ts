import type { ChatCompletionMessage, ChatCompletionTool } from '../chat/llm'
import type { ContextMeter } from '../chat/dto'
import {
  estimateMessageTokens,
  estimateRequestTokens,
  estimateTextTokens
} from '../tokens/estimate'

/**
 * 模型没填上下文窗口时的兜底:按主流的 128k 算。
 * 比早先的 32k 宽松得多 —— 窗口配小了裁剪会提前动手,白丢历史,而界面进度条也跟着说谎。
 * 本地运行时若把窗口压得更小(Ollama 的 num_ctx),要把模型的实际值配准。
 */
export const DEFAULT_CONTEXT_WINDOW = 131_072

/**
 * 从窗口里划走、不参与历史计算的输出预留。
 * 预留少了,模型写到一半才撞上限,而这在请求发出前无法预知。
 */
export const OUTPUT_RESERVE = 4_000

/** 估算误差的安全边界:只用窗口的 85% —— 宁可少留一轮,也别把请求顶到 400 */
const SAFETY_RATIO = 0.85

/** 超过这个 token 数的单条消息才考虑缩写;之下的留着,那点收益不值折腾 */
const SHRINK_THRESHOLD = 2_000

/** 缩写想达到的长度 */
const SHRINK_TARGET = 1_200

/** 兜底阶段把消息压到这里为止,再压就没信息可读了 */
const SHRINK_FLOOR = 300

/**
 * 省略标记必须是**纯陈述、不带祈使语气**。
 * 同 agent/history.ts 里占位文案的教训:"如需该信息请重新调用工具"会被模型当成本轮
 * 待办,于是它转头重跑上一轮的工具,整轮上下文跑偏。
 */
const OMITTED_PREFIX = '[为塞进上下文窗口,本条内容省略中间'

function omittedMark(chars: number): string {
  return `${OMITTED_PREFIX} ${chars} 字]`
}

export interface ContextBudget {
  /** 模型报告的窗口大小 */
  window: number
  /** 可用于「system prompt + 历史 + 工具定义」的输入额度 */
  input: number
}

/** 把模型配置的窗口大小换算成输入额度;无效或缺省都退回兜底值 */
export function budgetFor(contextWindow?: number): ContextBudget {
  const size =
    typeof contextWindow === 'number' && contextWindow > OUTPUT_RESERVE
      ? contextWindow
      : DEFAULT_CONTEXT_WINDOW
  // 窗口扣不掉输出预留时按 0 算,不能给负额度 —— 用户把窗口填得比输出预留还小时会踩到
  return { window: size, input: Math.max(0, Math.floor(size * SAFETY_RATIO) - OUTPUT_RESERVE) }
}

/** 一轮:一条 user 消息连同它之后的 assistant / tool 行 */
interface Turn {
  messages: ChatCompletionMessage[]
  tokens: number
}

/** 一轮内可整体弃留的最小单元:一次 assistant 输出 + 它发起的全部工具结果 */
interface Unit {
  messages: ChatCompletionMessage[]
  tokens: number
}

function tokensOf(messages: ChatCompletionMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
}

/**
 * 按 user 消息切轮。
 * 发起调用的 assistant 行和它的 tool 结果必然落在同一轮里,于是"整轮丢弃"结构上
 * 不可能产生孤儿 tool_calls —— 孤儿行是本项目已经踩过一次的坑,不能靠裁剪时小心配对,
 * 只能让它在结构上拆不开。
 */
function groupTurns(messages: ChatCompletionMessage[]): Turn[] {
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
 * 带着它自己的工具结果成一个单元 —— 弃就弃整个,不会出现"有调用无响应"。
 */
function splitUnits(turn: Turn): Unit[] {
  const units: Unit[] = []
  for (const message of turn.messages) {
    const startsUnit = message.role === 'assistant' || message.role === 'user'
    if (startsUnit || units.length === 0) {
      units.push({ messages: [message], tokens: estimateMessageTokens(message) })
      continue
    }
    const last = units[units.length - 1]
    last.messages.push(message)
    last.tokens += estimateMessageTokens(message)
  }
  return units
}

/** 保留头尾、省略中段;压无可压时原样返回 */
function clipText(text: string, maxTokens: number): string {
  const before = estimateTextTokens(text)
  if (before <= maxTokens) return text
  const ratio = maxTokens / before
  const head = Math.floor(text.length * 0.7 * ratio)
  const tail = Math.floor(text.length * 0.2 * ratio)
  const omitted = text.length - head - tail
  // 短到压无可压就别硬切,否则标记本身比正文还长
  if (omitted <= 0) return text
  return `${text.slice(0, head)}\n${omittedMark(omitted)}\n${text.slice(text.length - tail)}`
}

/**
 * 缩写一条消息,只动 content。
 * 不动 tool_calls.arguments:那段 JSON 是模型的原始输出,截断会留下非法 JSON,
 * 回放时端点按坏参数报错,比丢内容更难排查。
 * content 是多模态数组时原样返回,本项目当前不产这类消息。
 */
function shrinkMessage(message: ChatCompletionMessage, maxTokens: number): ChatCompletionMessage {
  if (typeof message.content !== 'string') return message
  const content = clipText(message.content, Math.max(SHRINK_FLOOR, maxTokens))
  return content === message.content ? message : { ...message, content }
}

/** 把一轮里超长的消息从最长的开始压,够额度就停 */
function shrinkTurn(turn: Turn, maxTokens: number): Turn {
  let over = turn.tokens - maxTokens
  if (over <= 0) return turn
  const next = [...turn.messages]
  const candidates = next
    .map((message, index) => ({ index, size: estimateMessageTokens(message) }))
    .filter((m) => m.size > SHRINK_THRESHOLD)
    .sort((a, b) => b.size - a.size)
  for (const { index, size } of candidates) {
    if (over <= 0) break
    // 一条压到位就停,不要把整轮消息都改成半截
    const target = Math.max(SHRINK_FLOOR, size - over, Math.min(size, SHRINK_TARGET))
    next[index] = shrinkMessage(next[index], target)
    over = tokensOf(next) - maxTokens
  }
  return { messages: next, tokens: tokensOf(next) }
}

/**
 * 最近一轮自己就超预算时的最后一级:弃掉轮内较早的单元,留下用户请求与最新一步。
 * 长工具链的 run 里,较早步骤的观察结果最不值钱 —— 结论已经在最新的 assistant 里了。
 */
function evictWithinTurn(turn: Turn, maxTokens: number): { turn: Turn; droppedMessages: number } {
  if (turn.tokens <= maxTokens) return { turn, droppedMessages: 0 }
  const units = splitUnits(turn)
  // 不足三个单元(请求 + 最新一步)时无从弃起,只能带着超预算发出去
  if (units.length <= 2) return { turn, droppedMessages: 0 }

  const head = units[0]
  const tail = units[units.length - 1]
  const middle = units.slice(1, -1)
  const keptUnits: Unit[] = [tail]
  let used = head.tokens + tail.tokens
  // 从最新往回收到塞不下为止:留连续后缀,中间挖洞会让模型误读步骤顺序
  for (let i = middle.length - 1; i >= 0; i--) {
    if (used + middle[i].tokens > maxTokens) break
    keptUnits.unshift(middle[i])
    used += middle[i].tokens
  }
  const messages = [head, ...keptUnits].flatMap((u) => u.messages)
  return {
    turn: { messages, tokens: tokensOf(messages) },
    droppedMessages: turn.messages.length - messages.length
  }
}

/** 被缩写过的消息内容里必然带省略标记 */
function isShrunk(message: ChatCompletionMessage): boolean {
  return typeof message.content === 'string' && message.content.includes(OMITTED_PREFIX)
}

export interface PlanInput {
  /** 固定在首位的系统提示 */
  system?: ChatCompletionMessage
  /** 参与裁剪的历史消息(不含 system,也不含本次现拼的循环控制消息) */
  history: ChatCompletionMessage[]
  /** 本次现拼的循环控制消息(收尾提示 + 目标锚定),永不丢弃 */
  pinned?: ChatCompletionMessage[]
  tools: ChatCompletionTool[]
  budget: ContextBudget
}

export interface ContextPlan {
  messages: ChatCompletionMessage[]
  meter: ContextMeter
}

/**
 * 把一次请求压进上下文预算,按代价从小到大三级降级:
 *   1. 整轮丢最旧的历史,只保留连续的最近若干轮(留空洞会让模型误读时序);
 *   2. 某轮只是个别消息过长 → 缩写它再试,不整轮扔;
 *   3. 最近一轮自己就超预算 → 弃掉轮内较早的步骤,再不行缩写它。
 * system prompt、工具定义、循环控制消息、用户本次的请求原文永不参与丢弃。
 * 压到下限仍然超预算时(窗口实在太小)会带着超限发出去,让端点报错,不静默改坏内容。
 */
export function planContext(input: PlanInput): ContextPlan {
  const head = input.system ? [input.system] : []
  const tail = input.pinned ?? []
  const available = Math.max(
    0,
    input.budget.input - estimateRequestTokens([...head, ...tail], input.tools)
  )

  const turns = groupTurns(input.history)
  const kept: Turn[] = []
  let used = 0
  let droppedTurns = 0
  let droppedMessages = 0

  for (let i = turns.length - 1; i >= 0; i--) {
    const isMostRecent = i === turns.length - 1
    const turn = turns[i]
    if (used + turn.tokens <= available) {
      kept.unshift(turn)
      used += turn.tokens
      continue
    }
    const shrunk = shrinkTurn(turn, available - used)
    if (isMostRecent || used + shrunk.tokens <= available) {
      if (isMostRecent) {
        const evicted = evictWithinTurn(shrunk, available - used)
        kept.unshift(evicted.turn)
        used += evicted.turn.tokens
        droppedMessages = evicted.droppedMessages
        // 最近一轮都已被压到底,更早的历史没有位置,全部丢弃
        droppedTurns = i
        break
      }
      kept.unshift(shrunk)
      used += shrunk.tokens
      continue
    }
    // 从这里往前的历史全部丢弃,保证保留下来的是连续后缀
    droppedTurns = i + 1
    break
  }

  // 顺序必须是 system → 历史 → 循环控制消息:目标锚定靠"近期性"起作用,
  // 排到历史前面就失去意义了(见 agent/loop.ts 的实测记录)。
  const messages = [...head, ...kept.flatMap((t) => t.messages), ...tail]
  return {
    messages,
    meter: {
      budget: input.budget.input,
      droppedTurns,
      droppedMessages,
      shrunkMessages: kept.reduce((sum, t) => sum + t.messages.filter(isShrunk).length, 0)
    }
  }
}
