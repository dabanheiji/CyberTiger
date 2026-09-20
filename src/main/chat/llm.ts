import OpenAI from 'openai'
import type { ToolCallRecord } from './dto'

export type ChatCompletionMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam
export type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionFunctionTool

/** 归一化后的流式增量:正文与思考过程都是本次 chunk 的新增片段 */
export interface StreamDelta {
  content: string
  reasoning: string
}

export interface StreamChatParams {
  baseUrl: string
  apiKey?: string
  model: string
  messages: ChatCompletionMessage[]
  /** 可供模型调用的工具;不传则纯对话 */
  tools?: ChatCompletionTool[]
  signal: AbortSignal
  /** 每收到一段增量时回调;正文和思考至少有一个非空 */
  onDelta: (delta: StreamDelta) => void
}

export interface StreamChatResult {
  /** 模型本轮发起的工具调用,参数已拼装完整;空数组表示没有 */
  toolCalls: ToolCallRecord[]
}

/**
 * 各家 OpenAI 兼容接口返回思考过程的字段名不统一,SDK 类型里也没有:
 * - reasoning_content:DeepSeek、Qwen(DashScope)、Kimi、SiliconFlow、llama.cpp、LM Studio、旧版 vLLM
 * - reasoning:Ollama、OpenRouter、新版 vLLM(已从 reasoning_content 改名)
 * - reasoning_details:OpenRouter 的结构化版本,每项按类型带 text 或 summary
 * 同时给两个字段的服务(如 llama.cpp deepseek-legacy 模式)以 reasoning_content 为准,不会重复。
 */
interface RawDelta {
  content?: string | null
  reasoning_content?: string | null
  reasoning?: string | null
  reasoning_details?: { text?: string | null; summary?: string | null }[] | null
  tool_calls?: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[]
}

/** 把不同供应商的 delta 归一为 { content, reasoning } */
export function normalizeDelta(raw: RawDelta): StreamDelta {
  let reasoning = raw.reasoning_content ?? raw.reasoning ?? ''
  if (!reasoning && Array.isArray(raw.reasoning_details)) {
    reasoning = raw.reasoning_details.map((d) => d?.text ?? d?.summary ?? '').join('')
  }
  return { content: raw.content ?? '', reasoning }
}

/** 按 index 累积流式分片的工具调用;id / name 通常只在首片,arguments 逐片拼接 */
class ToolCallAccumulator {
  private calls = new Map<number, ToolCallRecord>()

  push(deltas: RawDelta['tool_calls']): void {
    if (!deltas) return
    for (const d of deltas) {
      const existing = this.calls.get(d.index) ?? { id: '', name: '', arguments: '' }
      if (d.id) existing.id = d.id
      if (d.function?.name) existing.name = d.function.name
      if (d.function?.arguments) existing.arguments += d.function.arguments
      this.calls.set(d.index, existing)
    }
  }

  finish(): ToolCallRecord[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => ({
        ...c,
        // 个别服务不返回 id,tool 消息需要它来对应,这里兜底生成
        id: c.id || `call_${Date.now()}_${index}`
      }))
      .filter((c) => c.name)
  }
}

/**
 * 以 OpenAI 兼容协议流式调用 /chat/completions。
 * 被 signal 中止时正常 resolve,由调用方根据 signal.aborted 判断;其他错误抛出带可读提示的 Error。
 * 服务端不支持 tools(400 且报错含 tool)时会自动去掉 tools 重试一次。
 */
export async function streamChatCompletion(params: StreamChatParams): Promise<StreamChatResult> {
  const { baseUrl, apiKey, model, messages, tools, signal, onDelta } = params

  const client = new OpenAI({
    baseURL: baseUrl.replace(/\/+$/, ''),
    // SDK 要求 apiKey 非空;Ollama / vLLM 等本地服务会忽略这个占位值
    apiKey: apiKey?.trim() || 'EMPTY',
    maxRetries: 1
  })

  const run = async (withTools: boolean): Promise<StreamChatResult> => {
    const acc = new ToolCallAccumulator()
    const stream = await client.chat.completions.create(
      {
        model,
        messages,
        stream: true,
        ...(withTools && tools && tools.length > 0 ? { tools } : {})
      },
      { signal }
    )
    for await (const chunk of stream) {
      const raw = chunk.choices[0]?.delta as RawDelta | undefined
      if (!raw) continue
      acc.push(raw.tool_calls)
      const delta = normalizeDelta(raw)
      if (delta.content || delta.reasoning) onDelta(delta)
    }
    return { toolCalls: acc.finish() }
  }

  try {
    try {
      return await run(true)
    } catch (error) {
      if (!signal.aborted && isToolsUnsupported(error) && tools && tools.length > 0) {
        return await run(false)
      }
      throw error
    }
  } catch (error) {
    if (signal.aborted) return { toolCalls: [] }
    throw new Error(toReadableMessage(error, baseUrl, model))
  }
}

/** Ollama 等对不支持工具的模型返回 400 "does not support tools" */
function isToolsUnsupported(error: unknown): boolean {
  return (
    error instanceof OpenAI.BadRequestError && /tool/i.test(error.message)
  )
}

/** 把 SDK 的各类错误归一化为面向用户的中文提示 */
function toReadableMessage(error: unknown, baseUrl: string, model: string): string {
  if (error instanceof OpenAI.APIConnectionError) {
    return `无法连接到 ${baseUrl},请检查 Base URL`
  }
  if (error instanceof OpenAI.AuthenticationError) {
    return 'API Key 无效'
  }
  if (error instanceof OpenAI.NotFoundError) {
    return `模型 ${model} 不存在`
  }
  if (error instanceof OpenAI.APIError) {
    return `${error.status ?? ''} ${error.message}`.trim()
  }
  return error instanceof Error ? error.message : String(error)
}
