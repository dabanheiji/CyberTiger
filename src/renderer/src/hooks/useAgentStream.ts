import { useCallback, useEffect, useRef, useState } from 'react'
import type { IpcResult, ToolCallRecord } from '../../../main/chat/dto'

/** 流式中的一个工具调用及其执行状态 */
export interface StreamingToolCall extends ToolCallRecord {
  status: 'running' | 'success' | 'error'
  result?: string
}

/** Agent 的一步:一次模型调用产生的推理、正文与行动 */
export interface AgentStep {
  messageId: string
  content: string
  reasoning: string
  toolCalls: StreamingToolCall[]
}

/** 正在进行中的 Agent run */
export interface StreamingRun {
  conversationId: string
  runId: string
  steps: AgentStep[]
}

interface UseAgentStreamOptions {
  /** run 结束(含手动停止)。返回 Promise 时会等其完成后再清空 streaming,避免气泡闪烁 */
  onDone: (conversationId: string, aborted: boolean) => void | Promise<void>
  onError: (conversationId: string, msg: string) => void | Promise<void>
}

interface UseAgentStreamResult {
  streaming: StreamingRun | null
  /** 启动 Agent run,返回 IPC 结果;成功后开始接收流式事件 */
  start: (conversationId: string, model: string) => Promise<IpcResult<{ runId: string }>>
  /** 中止当前 run */
  abort: () => Promise<void>
}

/** 订阅主进程的 chat:stream 事件,维护当前 run 的各步累计状态 */
export function useAgentStream(options: UseAgentStreamOptions): UseAgentStreamResult {
  const [streaming, setStreaming] = useState<StreamingRun | null>(null)
  // 事件监听器里读取最新值,避免闭包拿到过期 state
  const streamingRef = useRef<StreamingRun | null>(null)
  const optionsRef = useRef(options)

  useEffect(() => {
    optionsRef.current = options
  })

  const update = useCallback((next: StreamingRun | null): void => {
    streamingRef.current = next
    setStreaming(next)
  }, [])

  useEffect(() => {
    const unsubscribe = window.api.chat.onStream(async (event) => {
      const current = streamingRef.current
      // 只处理当前 run 的事件,过期事件直接丢弃
      if (!current || current.runId !== event.runId) return

      switch (event.type) {
        case 'step_start':
          update({
            ...current,
            steps: [
              ...current.steps,
              { messageId: event.messageId, content: '', reasoning: '', toolCalls: [] }
            ]
          })
          return
        case 'delta':
          update({
            ...current,
            steps: current.steps.map((s) =>
              s.messageId === event.messageId
                ? {
                    ...s,
                    content: s.content + event.content,
                    reasoning: s.reasoning + event.reasoning
                  }
                : s
            )
          })
          return
        case 'tool_call':
          update({
            ...current,
            steps: current.steps.map((s) =>
              s.messageId === event.messageId
                ? { ...s, toolCalls: [...s.toolCalls, { ...event.call, status: 'running' }] }
                : s
            )
          })
          return
        case 'tool_result':
          update({
            ...current,
            steps: current.steps.map((s) => ({
              ...s,
              toolCalls: s.toolCalls.map((c) =>
                c.id === event.callId
                  ? { ...c, status: event.ok ? 'success' : 'error', result: event.result }
                  : c
              )
            }))
          })
          return
        case 'done':
          await optionsRef.current.onDone(event.conversationId, event.aborted)
          break
        case 'error':
          await optionsRef.current.onError(event.conversationId, event.msg)
          break
      }
      // 回调里通常会重新拉取消息,拉完再清空,列表里已有落库内容接替显示
      if (streamingRef.current?.runId === event.runId) update(null)
    })
    return unsubscribe
  }, [update])

  const start = useCallback(
    async (conversationId: string, model: string): Promise<IpcResult<{ runId: string }>> => {
      const res = await window.api.chat.generateReply({ conversationId, model })
      if (res.success) {
        update({ conversationId, runId: res.data.runId, steps: [] })
      }
      return res
    },
    [update]
  )

  const abort = useCallback(async (): Promise<void> => {
    const current = streamingRef.current
    if (!current) return
    await window.api.chat.abortReply(current.runId)
  }, [])

  return { streaming, start, abort }
}
