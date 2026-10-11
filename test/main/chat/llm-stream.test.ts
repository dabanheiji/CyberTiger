import { beforeEach, describe, expect, it, vi } from 'vitest'
import type OpenAI from 'openai'
import { streamChatCompletion, type ChatCompletionTool } from '../../../src/main/chat/llm'

/**
 * 用 vi.mock 把 openai SDK 换成假客户端:只替掉 chat.completions.create,
 * 错误类仍取真实的那些 —— llm.ts 的降级判断靠 instanceof OpenAI.BadRequestError,
 * 自己造的错误类过不了这一关,降级分支就永远测不到。
 */
const harness = vi.hoisted(() => ({
  /** 每次 create 收到的请求体,用来断言 tools / stream_options 有没有带 */
  requests: [] as Record<string, unknown>[],
  /** 第 n 个请求的行为:抛某种 400,或按 chunks 回流 */
  script: [] as Array<{ rejectAs?: 'bad-request' | 'auth'; message?: string; chunks?: unknown[] }>
}))

vi.mock('openai', async (importOriginal) => {
  const mod = (await importOriginal()) as { default: typeof OpenAI }
  const Actual = mod.default

  const FakeOpenAI = class {
    chat: { completions: { create: (params: Record<string, unknown>) => Promise<unknown> } }
    constructor() {
      this.chat = {
        completions: {
          create: async (params: Record<string, unknown>) => {
            harness.requests.push(params)
            const step = harness.script[harness.requests.length - 1]
            if (!step) throw new Error('测试脚本没排到这一步')
            if (step.rejectAs) {
              const Klass =
                step.rejectAs === 'bad-request'
                  ? Actual.BadRequestError
                  : Actual.AuthenticationError
              const error = Object.create(Klass.prototype) as Error
              Object.assign(error, { message: step.message ?? 'boom', status: 400 })
              throw error
            }
            return (async function* () {
              for (const chunk of step.chunks ?? []) yield chunk
            })()
          }
        }
      }
    }
  }

  return {
    default: Object.assign(FakeOpenAI, {
      BadRequestError: Actual.BadRequestError,
      AuthenticationError: Actual.AuthenticationError,
      NotFoundError: Actual.NotFoundError,
      APIConnectionError: Actual.APIConnectionError,
      APIError: Actual.APIError
    })
  } as unknown as typeof OpenAI
})

const textChunk = (content: string): unknown => ({ choices: [{ delta: { content } }] })
const usageChunk = (prompt: number, completion: number): unknown => ({
  usage: { prompt_tokens: prompt, completion_tokens: completion }
})

async function call(tools?: ChatCompletionTool[]): Promise<{
  usage?: { prompt: number; completion: number }
  collected: string
}> {
  let collected = ''
  const result = await streamChatCompletion({
    baseUrl: 'https://fake.test/v1',
    model: 'test-model',
    messages: [{ role: 'user', content: '你好' }],
    ...(tools ? { tools } : {}),
    signal: new AbortController().signal,
    onDelta: (delta) => {
      collected += delta.content
    }
  })
  return { ...(result.usage ? { usage: result.usage } : {}), collected }
}

/** 只用来给请求体添个 tools 字段,降级判断只看它在不在 */
const oneTool: ChatCompletionTool[] = [
  { type: 'function', function: { name: 'probe' } } as unknown as ChatCompletionTool
]

beforeEach(() => {
  harness.requests.length = 0
  harness.script.length = 0
})

describe('streamChatCompletion 的用量', () => {
  it('默认带上 include_usage,并读回最后一个只有 usage 的 chunk', async () => {
    harness.script.push({ chunks: [textChunk('你'), textChunk('好'), usageChunk(120, 8)] })
    const { usage, collected } = await call(oneTool)

    expect(usage).toEqual({ prompt: 120, completion: 8 })
    expect(collected).toBe('你好')
    expect(harness.requests[0]).toMatchObject({ stream_options: { include_usage: true } })
    expect(harness.requests).toHaveLength(1)
  })

  it('那个 usage chunk 整个没有 choices 也不会崩', async () => {
    harness.script.push({ chunks: [textChunk('正文'), { usage: { prompt_tokens: 5 } }] })
    const { usage, collected } = await call()

    expect(collected).toBe('正文')
    expect(usage).toEqual({ prompt: 5, completion: 0 })
  })

  it('端点不报 usage 时结果里就是没有该字段', async () => {
    harness.script.push({ chunks: [textChunk('正文')] })
    const { usage, collected } = await call()

    expect(usage).toBeUndefined()
    expect(collected).toBe('正文')
  })
})

describe('streamChatCompletion 的降级重试', () => {
  it('不认 stream_options 时去掉它重试,tools 维持下发', async () => {
    // 不认这个参数的端点也不会主动报 usage,重试那次的 chunks 里就没有 usage
    harness.script.push(
      { rejectAs: 'bad-request', message: 'Unsupported parameter: stream_options' },
      { chunks: [textChunk('好')] }
    )
    const { usage } = await call(oneTool)

    expect(usage).toBeUndefined()
    expect(harness.requests).toHaveLength(2)
    expect(harness.requests[1].stream_options).toBeUndefined()
    expect(harness.requests[1].tools).toBeDefined()
  })

  it('不认 tools 时只去掉 tools,stream_options 留着', async () => {
    harness.script.push(
      { rejectAs: 'bad-request', message: "Unexpected value 'tools' in payload" },
      { chunks: [textChunk('好'), usageChunk(30, 4)] }
    )
    const { usage } = await call(oneTool)

    expect(usage).toEqual({ prompt: 30, completion: 4 })
    expect(harness.requests[1].tools).toBeUndefined()
    expect(harness.requests[1].stream_options).toBeDefined()
  })

  it('两样都不认时退到最裸的请求,仍然把正文拿回来', async () => {
    harness.script.push(
      { rejectAs: 'bad-request', message: 'Unsupported parameter: stream_options' },
      { rejectAs: 'bad-request', message: 'this model requires tools but tools are unsupported' },
      { chunks: [textChunk('终于')] }
    )
    const { collected } = await call(oneTool)

    expect(collected).toBe('终于')
    expect(harness.requests).toHaveLength(3)
    expect(harness.requests[2].tools).toBeUndefined()
    expect(harness.requests[2].stream_options).toBeUndefined()
  })

  it('没有工具时不会为 tools 去重试', async () => {
    harness.script.push({ chunks: [textChunk('纯对话')] })
    const { collected } = await call()

    expect(collected).toBe('纯对话')
    expect(harness.requests).toHaveLength(1)
    expect(harness.requests[0].tools).toBeUndefined()
  })

  it('鉴权失败不是「参数不支持」,原样报错且不重试', async () => {
    harness.script.push({ rejectAs: 'auth', message: 'invalid api key' })
    await expect(call(oneTool)).rejects.toThrow('API Key 无效')
    expect(harness.requests).toHaveLength(1)
  })
})
