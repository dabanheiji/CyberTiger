import {
  streamChatCompletion,
  type ChatCompletionMessage,
  type StreamChatParams,
  type StreamChatResult
} from '../chat/llm'
import type { SummaryMetrics, TokenUsage } from '../chat/dto'
import { estimateRequestTokens, estimateTextTokens } from '../tokens/estimate'
import { splitIdentifiedUnits, type IdentifiedMessage } from './turns'

/**
 * 上下文压缩:把「水位之后的老对话」交给模型总结成一段摘要,此后请求只带摘要 + 最新消息。
 *
 * 与 agent/context.ts 的分工要分清,两者都会让请求变小,代价完全不同:
 *   - 裁剪(planContext)**改写或丢弃**消息,每步重算,请求前缀因此逐字节变动作废提示缓存;
 *   - 压缩(compactConversation)只在越过阈值那一次动手,水位之后的消息永远原文送出。
 * 常态下裁剪不该动手,它只兜「摘要之后仍装不下」(例如某条工具结果自己就几万 token)。
 */

/**
 * 摘要块的首行。
 * 与 agent/history.ts 的占位文案同一条纪律:**只陈述,不写祈使**。
 * 「请根据摘要继续完成任务」这类句子会被模型当成本轮待办;而这块消息以 user 角色出现在
 * 请求里,形似一条新提问 —— 不写清楚它只是背景,模型会转头去回答摘要里的旧问题。
 */
export const SUMMARY_BLOCK_PREFIX = '[前情摘要·背景信息,无需回应本条]'

/**
 * 这条消息是不是摘要块。
 * loop 靠它把摘要从「待裁剪的历史」里挑出来固定成头部:摘要每步都被重写没有意义,
 * 而它一旦被裁剪逻辑当成普通历史丢弃,模型就再也看不到此前发生过什么。
 */
export function isSummaryBlock(message: ChatCompletionMessage | undefined): boolean {
  if (message === undefined || message.role !== 'user') return false
  return typeof message.content === 'string' && message.content.startsWith(SUMMARY_BLOCK_PREFIX)
}

/**
 * 摘要块的完整内容:固定标记行 + 摘要正文。
 * 标记行的作用是消歧 —— 它以 user 角色出现,形似一条新提问,不写清楚就等着被当成待办。
 */
export function summaryBlock(summary: string): ChatCompletionMessage {
  return { role: 'user', content: `${SUMMARY_BLOCK_PREFIX}\n${summary}` }
}

/** 压缩策略的各项比例;全部相对「模型配置的窗口」,不相对裁剪后的额度 */
export interface CompactPolicy {
  /** 触发线:已用 / 窗口 ≥ 该值才自动压缩 */
  triggerRatio: number
  /** 压缩后的目标占用比例;留出一次 run 的增长余量,否则下一步又越线、连环烧调用 */
  targetRatio: number
  /** 单次摘要请求自己也要压进窗口:整段请求的上限比例 */
  chunkRatio: number
  /** 摘要正文的输出上限(token) */
  summaryMaxTokens: number
  /** 少于这么多单元不值得压:省不了多少还多烧一次调用 */
  minUnits: number
  /** 收益下限:压完省不到这个比例就放弃 */
  minSavingRatio: number
  /** 一次压缩最多调几次模型,防止小窗口会话把它变成十次调用 */
  maxChunks: number
}

export const DEFAULT_COMPACT_POLICY: CompactPolicy = {
  triggerRatio: 0.8,
  targetRatio: 0.35,
  chunkRatio: 0.6,
  summaryMaxTokens: 1200,
  minUnits: 3,
  minSavingRatio: 0.15,
  maxChunks: 4
}

/** 摘要请求里除指令和正文之外的固定开销(小节标题、说明句) */
const REQUEST_NOTES_RESERVE = 240

/** 单个摘要段至少给这么多正文空间,否则窗口再小也切不出下一段 */
const MIN_CHUNK_TOKENS = 600

/** 溢出段(没能原文送进摘要的更早历史)最多留多少个标识 */
const MAX_IDENTIFIERS = 60

/** 溢出段里每条用户请求最多带多少字符,只为保住「当时在问什么」 */
const MAX_REQUEST_SNIPPET = 80

/**
 * 摘要段:一批原文消息 + 它们在库里的水位落点。
 *
 * 边界只能落在单元边界(规则见 agent/turns.ts):切在「有 tool_calls 无响应」中间,
 * 喂给摘要模型的片段本身就是残缺协议,而新水位会永久跳过那半截 —— 等于把协议错误固化下来。
 */
export interface CompactUnit {
  messages: ChatCompletionMessage[]
  tokens: number
  /** 本单元最后一条消息的库内 id:被摘要覆盖后水位推到它 */
  lastId: string
}

/** 按单元边界把「带 id 的消息」分组(单元规则与裁剪共用一份,见 agent/turns.ts) */
export function toCompactUnits(items: IdentifiedMessage[]): CompactUnit[] {
  return splitIdentifiedUnits(items).map((unit) => ({
    messages: unit.items.map((item) => item.message),
    tokens: unit.tokens,
    lastId: unit.items[unit.items.length - 1].id
  }))
}

/** 一次请求里与对话内容无关、但每次都占着位置的开销 */
export interface CompactSizing {
  /** system prompt + 工具定义 + 循环控制消息 */
  fixedTokens: number
  /** 当前生效摘要的 token 数;0 表示还没压过 */
  summaryTokens: number
  /** 模型配置的上下文窗口 */
  window: number
}

/** 拒绝压缩的原因;界面要能据此解释「现在按了也省不出空间」 */
export type CompactReason = 'below-trigger' | 'too-few-units' | 'poor-saving'

export interface CompactPlan {
  /** 水位要越过的那些单元:摘要覆盖到的连续前缀(含 dropped) */
  covered: CompactUnit[]
  /** 送进摘要请求的连续前缀(按段分好) */
  chunks: CompactUnit[][]
  /** 原文保留的后缀 */
  kept: CompactUnit[]
  /** 因段数上限而连摘要都没进过的更早单元;由 earlierDigest 给出标识清单 */
  dropped: CompactUnit[]
  coveredTokens: number
  coveredMessages: number
  /** 压缩后的预计占用(按摘要长度上限算,实际只会更小) */
  projectedTokens: number
  savedTokens: number
}

export type CompactDecision =
  { should: true; plan: CompactPlan } | { should: false; reason: CompactReason }

function sumTokens(units: CompactUnit[]): number {
  return units.reduce((sum, unit) => sum + unit.tokens, 0)
}

function countMessages(units: CompactUnit[]): number {
  return units.reduce((sum, unit) => sum + unit.messages.length, 0)
}

/**
 * 选出「压到哪为止」:纯函数,不碰模型也不碰数据库。
 *
 * 保留的是**最长后缀**:从最新往回收,收到装不下为止 —— 留在原文里的永远是最近的对话。
 * 最新那个单元无条件保留:它就是用户刚问的事,摘要救不了它(要摘要就得把它发给模型,
 * 同样的窗口未必装得下),而丢掉它等于答非所问。
 *
 * `force` 只越过触发线这一条:手动压缩时用户已经决定要压。
 * 单元数与收益不足照样拒绝 —— 那两种情况下压完省不出空间,还白烧一次调用。
 */
export function planCompaction(
  units: CompactUnit[],
  sizing: CompactSizing,
  policy: CompactPolicy = DEFAULT_COMPACT_POLICY,
  force = false
): CompactDecision {
  const used = sizing.fixedTokens + sizing.summaryTokens + sumTokens(units)
  if (!force && used < policy.triggerRatio * sizing.window) {
    return { should: false, reason: 'below-trigger' }
  }

  // 压缩后的预算:固定开销 + 一份新摘要的上限 + 原文后缀 ≤ targetRatio × 窗口
  const keepAllowance = Math.max(
    0,
    Math.floor(policy.targetRatio * sizing.window) - sizing.fixedTokens - policy.summaryMaxTokens
  )

  const kept: CompactUnit[] = []
  let keptTokens = 0
  for (let i = units.length - 1; i >= 0; i--) {
    if (kept.length > 0 && keptTokens + units[i].tokens > keepAllowance) break
    kept.unshift(units[i])
    keptTokens += units[i].tokens
  }

  const covered = units.slice(0, units.length - kept.length)
  if (covered.length < policy.minUnits) {
    return { should: false, reason: 'too-few-units' }
  }

  const projectedTokens = sizing.fixedTokens + policy.summaryMaxTokens + keptTokens
  const savedTokens = used - projectedTokens
  if (savedTokens < policy.minSavingRatio * used) {
    return { should: false, reason: 'poor-saving' }
  }

  const { chunks, dropped } = splitChunks(covered, chunkLimit(sizing, policy), policy.maxChunks)
  return {
    should: true,
    plan: {
      covered,
      chunks,
      kept,
      dropped,
      coveredTokens: sumTokens(covered),
      coveredMessages: countMessages(covered),
      projectedTokens,
      savedTokens
    }
  }
}

/**
 * 摘要请求留给对话正文的额度:整段上限扣掉指令、旧摘要(按长度上限预留)与说明句。
 * 指令长度随 summaryMaxTokens 变,所以每次都要现算再估它自己的 token 数。
 */
export function chunkLimit(
  sizing: CompactSizing,
  policy: CompactPolicy = DEFAULT_COMPACT_POLICY
): number {
  return Math.max(
    MIN_CHUNK_TOKENS,
    Math.floor(policy.chunkRatio * sizing.window) -
      estimateTextTokens(summaryInstructions(policy)) -
      policy.summaryMaxTokens -
      REQUEST_NOTES_RESERVE
  )
}

/**
 * 按请求额度从最旧开始贪心分段,段数不超过 maxChunks。
 *
 * 段数超上限时**不静默丢内容**:保留最新的若干段原样,把最旧那段能塞进请求的部分照样送去
 * 摘要,塞不下的更早部分转成 dropped —— 调用方为它生成标识清单并如实告诉模型「这段可能缺细节」。
 * 单个单元自己就超额度时它独占一段(单元不可再切,切了就破坏协议)。
 */
export function splitChunks(
  covered: CompactUnit[],
  limit: number,
  maxChunks: number
): { chunks: CompactUnit[][]; dropped: CompactUnit[] } {
  const groups: CompactUnit[][] = []
  let current: CompactUnit[] = []
  let used = 0
  for (const unit of covered) {
    if (current.length > 0 && used + unit.tokens > limit) {
      groups.push(current)
      current = []
      used = 0
    }
    current.push(unit)
    used += unit.tokens
  }
  if (current.length > 0) groups.push(current)
  if (groups.length <= maxChunks) return { chunks: groups, dropped: [] }

  // 前 (groups.length - maxChunks + 1) 段挤成第一段,再从新到旧收进额度,收不下的归 dropped
  const front: CompactUnit[] = []
  for (let i = 0; i <= groups.length - maxChunks; i++) front.push(...groups[i])
  const tail = groups.slice(groups.length - maxChunks + 1)

  const sent: CompactUnit[] = []
  let room = 0
  for (let i = front.length - 1; i >= 0; i--) {
    if (sent.length > 0 && room + front[i].tokens > limit) break
    sent.unshift(front[i])
    room += front[i].tokens
  }
  return { chunks: [sent, ...tail], dropped: front.slice(0, front.length - sent.length) }
}

/** URL / 路径 / 带扩展名的文件名 / 反引号代码:溢出段里最值得留下的东西 */
const identifierPatterns = [
  /https?:\/\/[^\s"'`）)】\]]+/g,
  /[\w.-]+(?:\/[\w.-]+)+/g,
  /[\w-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|java|sql|sh|ya?ml|toml)/g,
  /`[^`\n]{2,120}`/g
]

function textOf(message: ChatCompletionMessage): string {
  return typeof message.content === 'string' ? message.content : ''
}

/**
 * 为「连摘要都没进过」的更早历史生成一段可核对的清单。
 * 只抽标识符和用户请求的开头:让模型知道「这段里出现过哪些路径与链接、当时在问什么」,
 * 而不是假装掌握了全过程 —— 所以文案明说细节可能缺失。
 */
export function earlierDigest(units: CompactUnit[]): string {
  if (units.length === 0) return ''
  const found: string[] = []
  const requests: string[] = []
  outer: for (const unit of units) {
    for (const message of unit.messages) {
      const text = textOf(message)
      if (message.role === 'user' && text) {
        requests.push(
          text.length > MAX_REQUEST_SNIPPET ? `${text.slice(0, MAX_REQUEST_SNIPPET)}…` : text
        )
      }
      for (const pattern of identifierPatterns) {
        for (const match of text.match(pattern) ?? []) {
          if (!found.includes(match)) found.push(match)
          if (found.length >= MAX_IDENTIFIERS) break outer
        }
      }
    }
  }
  const lines = [
    `以下 ${countMessages(units)} 条消息因为超出单次摘要的长度上限,没有原文送给模型;这一节的过程细节可能缺失,只留下可以核对的标识:`
  ]
  if (requests.length > 0) {
    lines.push('用户在这段里问过的事:')
    lines.push(...requests.map((request) => `- ${request}`))
  }
  if (found.length > 0) {
    lines.push('出现过的标识(URL、路径、文件名、代码片段):')
    lines.push(...found.map((item) => `- ${item}`))
  }
  if (found.length >= MAX_IDENTIFIERS) lines.push(`(标识清单到此为止,共 ${found.length} 项)`)
  return lines.join('\n')
}

/**
 * 摘要请求顶部的指令。
 * 「原样保留标识符」与「某节为空写(无)」是给本地小模型准备的护栏:少了这两条,
 * 4b 级别的模型会把文件路径改写成中文描述、并整节漏掉。
 * 「工具调用只记结论」配合 goalAnchor 的「已拿到的不需要重新获取」防止续跑时重复调用,
 * 这里同样不写祈使句。
 */
export function summaryInstructions(policy: CompactPolicy = DEFAULT_COMPACT_POLICY): string {
  return [
    '你是上下文压缩器。把「已知前情」与「本段对话」合并成一份替换前情的摘要,供同一个助手继续工作。',
    '要求:',
    '1. 只写对话中出现过的事实,不推测、不补全、不评价。',
    '2. 文件路径、URL、标识符、命令、数字与单位、用户明确否决或指定的做法,一律原样保留字符串。',
    '3. 某一个小节没有信息就写「(无)」,不要省略小节标题。',
    '4. 工具调用只记结论:调用了什么、参数要点、得到什么;不复述原始输出。',
    `5. 全文不超过 ${policy.summaryMaxTokens} token。输出即摘要正文,不带额外说明。`,
    '',
    '按以下小节输出:',
    '## 会话目标:用户最初要办的事;目标被用户改动过就以最后一次为准,并写明改过。',
    '## 关键事实与约束:仍然成立的背景、用户偏好、环境信息、已确认的取舍。',
    '## 已完成:按时间顺序,每条一行。',
    '## 进行中:目的 / 已拿到的信息 / 下一步;没有在做的事写「(无)」。',
    '## 待办与未解决问题'
  ].join('\n')
}

/** 组装一次摘要请求:指令 → 已知前情(+ 溢出清单)→ 本段原文 → 执行状态便签 */
export function summaryRequest(input: {
  instructions: string
  previous: string
  earlier?: string
  chunk: ChatCompletionMessage[]
  note?: string
}): ChatCompletionMessage[] {
  const head = [`## 已知前情(可能为空)\n${input.previous || '(无)'}`]
  if (input.earlier) head.push(`## 更早的历史\n${input.earlier}`)
  head.push('## 本段对话(以下消息原文即为待总结的对话)')
  const note = input.note
    ? [
        {
          role: 'user' as const,
          content: `## 本轮执行状态\n${input.note}\n\n这些内容同样要写进摘要,尤其是「进行中」一节。`
        }
      ]
    : []
  return [
    { role: 'system', content: input.instructions },
    { role: 'user', content: head.join('\n\n') },
    ...input.chunk,
    ...note
  ]
}

/** 摘要正文的软上限:估算超过才硬切,切在整行末尾 */
function clipSummary(text: string, policy: CompactPolicy): string {
  if (estimateTextTokens(text) <= policy.summaryMaxTokens) return text
  // 中英混排的字符/token 差距很大(1~4),按 3 折中取一个保守的字符数
  const chars = Math.floor(policy.summaryMaxTokens * 3)
  const cut = text.slice(0, chars)
  const lineEnd = cut.lastIndexOf('\n')
  const body = lineEnd > chars * 0.5 ? cut.slice(0, lineEnd) : cut
  return `${body.trimEnd()}\n[摘要超出长度上限,此后内容省略]`
}

/** 一次压缩的输入;plan 来自 planCompaction,要不要 force 由调用方决定 */
export interface CompactInput {
  baseUrl: string
  apiKey?: string
  model: string
  signal: AbortSignal
  /** 当前生效的摘要;新摘要在它的基础上合并 —— 替换语义下靠这一条不丢前情 */
  previousSummary: string
  plan: CompactPlan
  policy?: CompactPolicy
  /** 执行状态便签,追加在最后一段之后(见 taskStateNote) */
  stateNote?: string
  /** 与 agent/loop.ts 同风格的注入点:脚本化模型即可验证分段、上限与失败分支 */
  stream?: (params: StreamChatParams) => Promise<StreamChatResult>
}

/** 压缩结果;`ok === false` 时 untilMessageId 是空串,调用方因此不会写水位 */
export interface CompactOutcome {
  ok: boolean
  summary: string
  untilMessageId: string
  usage: TokenUsage
  metrics?: SummaryMetrics
  /** 失败原因(面向用户的中文提示) */
  msg?: string
  aborted: boolean
}

/**
 * 滚动分段摘要:每段的请求 = 指令 + 上一段的结果 + 本段原文。
 *
 * 为什么分段:待摘要的对话本身就可能超过窗口,「把全部对话发给模型」这件事自己就超窗。
 * 为什么滚动携带旧摘要:替换语义下新摘要要把旧摘要并进来,否则第二次压缩会把第一次的结果丢掉。
 *
 * 任何一段报错、被中止或返回空正文都算整次压缩失败:返回 ok=false 且不给水位,
 * 由调用方保持原水位。绝不用半截摘要冒充完整摘要。
 */
export async function compactConversation(input: CompactInput): Promise<CompactOutcome> {
  const stream = input.stream ?? streamChatCompletion
  const policy = input.policy ?? DEFAULT_COMPACT_POLICY
  const instructions = summaryInstructions(policy)
  const digest = earlierDigest(input.plan.dropped)

  let rolling = input.previousSummary
  let prompt = 0
  let completion = 0
  let estimated = false
  let failed: string | undefined
  let aborted = false

  for (let i = 0; i < input.plan.chunks.length; i++) {
    if (input.signal.aborted) {
      aborted = true
      break
    }
    const messages = summaryRequest({
      instructions,
      previous: rolling,
      ...(i === 0 && digest ? { earlier: digest } : {}),
      chunk: input.plan.chunks[i].flatMap((unit) => unit.messages),
      ...(i === input.plan.chunks.length - 1 && input.stateNote ? { note: input.stateNote } : {})
    })
    const outcome = await summarizeOne(stream, {
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      signal: input.signal,
      messages
    })
    if ('error' in outcome) {
      failed = outcome.error
      aborted = outcome.aborted
      break
    }
    prompt += outcome.usage.prompt
    completion += outcome.usage.completion
    estimated ||= outcome.usage.estimated
    if (!outcome.text.trim()) {
      failed = '模型没有产出摘要内容'
      break
    }
    rolling = clipSummary(outcome.text.trim(), policy)
  }

  const usage: TokenUsage = { prompt, completion, estimated }
  if (failed || aborted) {
    return {
      ok: false,
      summary: '',
      untilMessageId: '',
      usage,
      aborted,
      ...(failed ? { msg: failed } : {})
    }
  }

  // 段数上限之外、连摘要都没进过的更早内容:把标识清单原样接在摘要后面。
  // 摘要模型可能没把它写进正文,而水位一旦越过这些消息,除了这段清单它们就真的消失了 ——
  // 宁可让摘要比 summaryMaxTokens 长出这一截(清单本身有 MAX_IDENTIFIERS 上限)。
  const summary = digest ? `${rolling}\n\n## 更早的历史(细节缺失)\n${digest}` : rolling

  const metrics: SummaryMetrics = {
    prompt,
    completion,
    estimated,
    coveredMessages: input.plan.coveredMessages,
    coveredTokens: input.plan.coveredTokens,
    at: new Date().toISOString()
  }
  return {
    ok: true,
    summary,
    untilMessageId: lastCoveredId(input.plan),
    usage,
    metrics,
    aborted: false
  }
}

/** 水位落点:被摘要覆盖的最后一条消息的 id */
export function lastCoveredId(plan: CompactPlan): string {
  const lastChunk = plan.chunks[plan.chunks.length - 1]
  const last = lastChunk?.[lastChunk.length - 1]
  return last?.lastId ?? ''
}

interface SummarizeInput {
  baseUrl: string
  apiKey?: string
  model: string
  signal: AbortSignal
  messages: ChatCompletionMessage[]
}

type SummarizeResult = { text: string; usage: TokenUsage } | { error: string; aborted: boolean }

/** 单次摘要调用:正文靠 onDelta 累积;不给工具,摘要不该动手 */
async function summarizeOne(
  stream: (params: StreamChatParams) => Promise<StreamChatResult>,
  input: SummarizeInput
): Promise<SummarizeResult> {
  let text = ''
  try {
    const result = await stream({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      messages: input.messages,
      signal: input.signal,
      onDelta: (delta) => {
        text += delta.content
      }
    })
    if (input.signal.aborted) return { error: '压缩已被中止', aborted: true }
    return {
      text,
      usage: result.usage
        ? { prompt: result.usage.prompt, completion: result.usage.completion, estimated: false }
        : {
            prompt: estimateRequestTokens(input.messages),
            completion: estimateTextTokens(text),
            estimated: true
          }
    }
  } catch (error) {
    if (input.signal.aborted) return { error: '压缩已被中止', aborted: true }
    return { error: error instanceof Error ? error.message : String(error), aborted: false }
  }
}

/** 便签里每条工具结论的截断长度:摘要请求自己也要留额度 */
const NOTE_RESULT_CLIP = 160

export interface TaskStateInput {
  /** 本轮要回答的请求 */
  request: string
  step: number
  maxSteps: number
  /** 本轮已执行的工具与结论 */
  executed: { name: string; arguments: string; ok: boolean; result: string }[]
  /** 最新一条助手正文:判断「下一步」的根据 */
  lastAssistant: string
}

/**
 * 执行状态便签:告诉摘要模型「正在做什么、已经拿到什么、还剩几步」。
 *
 * 它是任务能跨压缩续跑的唯一保证 —— 压缩把此前的步骤换成了摘要,若摘要里没有
 * 「已执行过 X 并得到 Y」,模型续跑时会把 X 重做一遍。
 * 便签追加在**待摘要内容之后**再送进模型(而不是拼在结果之后),于是它成为摘要的输入之一,
 * 自然落进「进行中」一节。
 */
export function taskStateNote(input: TaskStateInput): string {
  const lines = [
    `- 本轮目标:${input.request}`,
    `- 进度:第 ${input.step} 步,最多 ${input.maxSteps} 步,剩余 ${Math.max(0, input.maxSteps - input.step)} 步`
  ]
  if (input.executed.length === 0) {
    lines.push('- 已执行的工具:(无)')
  } else {
    lines.push('- 已执行的工具与结论:')
    for (const call of input.executed) {
      const result = call.result.replace(/\s+/g, ' ').slice(0, NOTE_RESULT_CLIP)
      lines.push(`  - ${call.name}(${call.arguments}) → ${call.ok ? '成功' : '失败'}:${result}`)
    }
  }
  const assistant = input.lastAssistant.replace(/\s+/g, ' ').slice(0, NOTE_RESULT_CLIP)
  lines.push(`- 最新的助手输出:${assistant || '(无)'}`)
  lines.push('- 下一步:据上面的输出判断还没做完的动作')
  return lines.join('\n')
}
