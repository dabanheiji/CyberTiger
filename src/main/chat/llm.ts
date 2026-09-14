import OpenAI from 'openai'

/** 发给模型的单条消息 */
export interface ChatCompletionMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface StreamChatParams {
  baseUrl: string
  apiKey?: string
  model: string
  messages: ChatCompletionMessage[]
  signal: AbortSignal
  /** 每收到一段正文增量时回调 */
  onDelta: (text: string) => void
}

/**
 * 以 OpenAI 兼容协议流式调用 /chat/completions。
 * 被 signal 中止时正常 resolve,由调用方根据 signal.aborted 判断;其他错误抛出带可读提示的 Error。
 */
export async function streamChatCompletion(params: StreamChatParams): Promise<void> {
  const { baseUrl, apiKey, model, messages, signal, onDelta } = params

  const client = new OpenAI({
    baseURL: baseUrl.replace(/\/+$/, ''),
    // SDK 要求 apiKey 非空;Ollama / vLLM 等本地服务会忽略这个占位值
    apiKey: apiKey?.trim() || 'EMPTY',
    maxRetries: 1
  })

  try {
    const stream = await client.chat.completions.create({ model, messages, stream: true }, { signal })
    for await (const chunk of stream) {
      // 只取正文;reasoning_content(DeepSeek 等的思考过程)本期忽略
      const delta = chunk.choices[0]?.delta?.content
      if (delta) onDelta(delta)
    }
  } catch (error) {
    if (signal.aborted) return
    throw new Error(toReadableMessage(error, baseUrl, model))
  }
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
