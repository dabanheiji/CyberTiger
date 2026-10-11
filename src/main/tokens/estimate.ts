import type { ChatCompletionMessage, ChatCompletionTool } from '../chat/llm'

/**
 * token 估算:上下文裁剪必须在请求**发出之前**判断,而真实 usage 只有响应回来才知道,
 * 所以预算只能靠估算。
 *
 * 系数取自经验值,刻意不追求精确:各家 OpenAI 兼容端点的分词器本就不同
 * (国产模型中文约 0.7 token/字,cl100k 约 1.5),想精确只能是个假象。
 * 真实 usage 与估算值会同时落库,事后可以用比值校准这里的系数。
 * 安全边界由 agent/context.ts 的预算统一留出,不在估算里重复放大。
 */

/** 中文与全角标点:按 1 token/字取中间值 */
const CJK_TOKENS_PER_CHAR = 1

/** 英文与代码:经验值约 4 字符/token */
const ASCII_CHARS_PER_TOKEN = 4

/** JSON(工具参数与 schema)短 token 密集,折得保守一些 */
const JSON_CHARS_PER_TOKEN = 3

/** 每条消息除内容外的固定开销:role 标记、分隔符、可选的 name */
const PER_MESSAGE_OVERHEAD = 4

/** 每个工具调用除参数外的固定开销:id 与函数名 */
const PER_TOOL_CALL_OVERHEAD = 8

/** 请求尾部为模型回复预留的标记开销 */
const REPLY_PRIMING_OVERHEAD = 3

/**
 * CJK 统一表意文字、日文假名、全角标点、CJK 扩展 B 区。
 * 不含西里尔/希腊等字母文字 —— 它们和英文一样按字符数折算。
 */
const CJK_PATTERN =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\u{20000}-\u{2ffff}]/gu

/** 估算一段纯文本的 token 数;中英混排按各自系数相加 */
export function estimateTextTokens(text: string, charsPerToken = ASCII_CHARS_PER_TOKEN): number {
  if (!text) return 0
  const cjk = text.match(CJK_PATTERN)?.length ?? 0
  const other = text.length - cjk
  return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + other / charsPerToken)
}

/** 估算 JSON 值的 token 数;序列化失败(循环引用等)时退回 String(value) */
export function estimateJsonTokens(value: unknown): number {
  let text: string
  try {
    text = JSON.stringify(value) ?? ''
  } catch {
    text = String(value)
  }
  return estimateTextTokens(text, JSON_CHARS_PER_TOKEN)
}

/** content 可能是字符串、多模态数组或 null;图片部分本项目不接,只算文本 */
function estimateContentTokens(content: unknown): number {
  if (content == null) return 0
  if (typeof content === 'string') return estimateTextTokens(content)
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => {
      const text = typeof part === 'object' && part !== null && 'text' in part ? part.text : ''
      return sum + (typeof text === 'string' ? estimateTextTokens(text) : 0)
    }, 0)
  }
  return estimateTextTokens(String(content))
}

/** 估算一条协议消息的 token 数,含它发起的工具调用 */
export function estimateMessageTokens(message: ChatCompletionMessage): number {
  let tokens = PER_MESSAGE_OVERHEAD + estimateContentTokens(message.content)
  if ('name' in message && typeof message.name === 'string') {
    tokens += estimateTextTokens(message.name)
  }
  if ('tool_calls' in message && message.tool_calls) {
    for (const call of message.tool_calls) {
      const { name, args } = describeCall(call)
      tokens +=
        PER_TOOL_CALL_OVERHEAD +
        estimateTextTokens(name) +
        estimateTextTokens(args, JSON_CHARS_PER_TOKEN)
    }
  }
  return tokens
}

/**
 * 取一次工具调用的名字与参数文本。
 * SDK 的调用类型有 function / custom 两支,这里按形状兜一层,
 * 估算只需要"有多少字符",不关心它是哪一支。
 */
function describeCall(call: unknown): { name: string; args: string } {
  const raw = call as Record<string, unknown>
  const inner = (raw.function ?? raw.custom ?? raw) as Record<string, unknown>
  return { name: asText(inner.name), args: asText(inner.arguments) || asText(inner.input) }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 估算 tools 参数占的 token:每个工具的 name / description / 整份 JSON schema */
export function estimateToolsTokens(tools: ChatCompletionTool[]): number {
  return tools.reduce(
    (sum, tool) => sum + PER_MESSAGE_OVERHEAD + estimateJsonTokens(tool.function),
    0
  )
}

/** 估算一次完整请求(消息列表 + 工具定义)的输入 token */
export function estimateRequestTokens(
  messages: ChatCompletionMessage[],
  tools?: ChatCompletionTool[]
): number {
  const fromMessages = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
  const fromTools = tools && tools.length > 0 ? estimateToolsTokens(tools) : 0
  return fromMessages + fromTools + REPLY_PRIMING_OVERHEAD
}

/** 界面用的紧凑写法:1234 → 1.2k,整千数不带小数尾巴 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const k = tokens / 1000
  return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`
}
