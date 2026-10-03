import { useCallback, useEffect, useRef, useState } from 'react'
import type { IpcResult } from '../../../main/chat/dto'
import type { ModelRef } from '../../../main/store/types'
import { emptyStep, mapCall, mapStep, type AgentStep } from '../lib/agentSteps'

export type { AgentStep, StreamingToolCall } from '../lib/agentSteps'

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
  start: (conversationId: string, ref: ModelRef) => Promise<IpcResult<{ runId: string }>>
  /** 中止当前 run */
  abort: () => Promise<void>
}

/**
 * 订阅主进程的 chat:stream 事件,维护当前 run 的各步累计状态。
 * 子 Agent 的事件带 parentCallId,会挂到发起它的那次 task 调用下面,形成嵌套结构。
 */
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
      if (!current || current.runId !== event.scope.runId) return
      // 子 Agent 的子 run 不发 done / error,这里再兜一道,避免误清整轮
      if (event.scope.depth !== 0 && (event.type === 'done' || event.type === 'error')) return

      switch (event.type) {
        case 'step_start':
          update({
            ...current,
            steps:
              event.scope.parentCallId === ''
                ? [...current.steps, emptyStep(event.messageId)]
                : mapCall(current.steps, event.scope.parentCallId, (call) => ({
                    ...call,
                    agentName: event.scope.agent,
                    agentSteps: [...(call.agentSteps ?? []), emptyStep(event.messageId)]
                  }))
          })
          return
        case 'delta':
          update({
            ...current,
            steps: mapStep(current.steps, event.messageId, (step) => ({
              ...step,
              content: step.content + event.content,
              reasoning: step.reasoning + event.reasoning
            }))
          })
          return
        case 'tool_call':
          update({
            ...current,
            steps: mapStep(current.steps, event.messageId, (step) => ({
              ...step,
              toolCalls: [...step.toolCalls, { ...event.call, status: 'running' }]
            }))
          })
          return
        case 'tool_result':
          update({
            ...current,
            steps: mapCall(current.steps, event.callId, (call) => ({
              ...call,
              status: event.ok ? 'success' : 'error',
              result: event.result,
              reused: event.reused === true
            }))
          })
          return
        case 'done':
          await optionsRef.current.onDone(event.scope.conversationId, event.aborted)
          break
        case 'error':
          await optionsRef.current.onError(event.scope.conversationId, event.msg)
          break
      }
      // 回调里通常会重新拉取消息,拉完再清空,列表里已有落库内容接替显示
      if (streamingRef.current?.runId === event.scope.runId) update(null)
    })
    return unsubscribe
  }, [update])

  const start = useCallback(
    async (conversationId: string, ref: ModelRef): Promise<IpcResult<{ runId: string }>> => {
      const res = await window.api.chat.generateReply({
        conversationId,
        providerId: ref.providerId,
        model: ref.model
      })
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
