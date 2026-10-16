import { useCallback, useEffect, useRef, useState } from 'react'
import type { IpcResult } from '../../../main/chat/dto'
import type { ModelRef } from '../../../main/store/types'
import { ensureStep, mapCall, mapStep, type AgentStep } from '../lib/agentSteps'

export type { AgentStep, StreamingToolCall } from '../lib/agentSteps'

/** 正等着用户回答的那一次提问 */
export interface PendingQuestion {
  /** 回答案时凭它认领:主进程那边的等待挂在这个 id 上 */
  questionId: string
  /** 发起提问的那次工具调用 id:它的结果到手即表示这次等待已经了结 */
  callId: string
  question: string
  options: string[]
  multiSelect: boolean
}

/** 正在进行中的 Agent run */
export interface StreamingRun {
  conversationId: string
  runId: string
  steps: AgentStep[]
  /**
   * 有值就是模型正等着用户选择(run 阻塞在那次 ask_user 调用上)。
   * 清掉它的时机是同一次调用的 tool_result 到手,而不是提交动作本身 —— 提交失败时卡片得留下。
   */
  pendingQuestion: PendingQuestion | null
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
          update({ ...current, steps: ensureStep(current.steps, event.scope, event.messageId) })
          return
        case 'delta': {
          // 建步的那条事件可能没赶上(见 ensureStep),这里先保证步骤有地方落
          const steps = ensureStep(current.steps, event.scope, event.messageId)
          update({
            ...current,
            steps: mapStep(steps, event.messageId, (step) => ({
              ...step,
              content: step.content + event.content,
              reasoning: step.reasoning + event.reasoning
            }))
          })
          return
        }
        case 'tool_call': {
          const steps = ensureStep(current.steps, event.scope, event.messageId)
          update({
            ...current,
            steps: mapStep(steps, event.messageId, (step) => ({
              ...step,
              toolCalls: [...step.toolCalls, { ...event.call, status: 'running' }]
            }))
          })
          return
        }
        case 'tool_result':
          update({
            ...current,
            steps: mapCall(current.steps, event.callId, (call) => ({
              ...call,
              status: event.ok ? 'success' : 'error',
              result: event.result,
              reused: event.reused === true
            })),
            // 那次提问有了结(用户答了、跳了、或本轮中止),卡片就该收起
            pendingQuestion:
              current.pendingQuestion?.callId === event.callId ? null : current.pendingQuestion
          })
          return
        case 'ask_user':
          update({
            ...current,
            pendingQuestion: {
              questionId: event.questionId,
              callId: event.callId,
              question: event.question,
              options: event.options,
              multiSelect: event.multiSelect
            }
          })
          return
        case 'usage': {
          const steps = ensureStep(current.steps, event.scope, event.messageId)
          update({
            ...current,
            steps: mapStep(steps, event.messageId, (step) => ({
              ...step,
              usage: event.usage,
              context: event.context
            }))
          })
          return
        }
        case 'compact':
          // 中途压缩换掉的是历史前缀,不改各步内容,界面也不显示它(账目在会话行上)。
          // 这条 case 不能省:落到 switch 末尾会把正在流式的整轮状态清空。
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
        update({ conversationId, runId: res.data.runId, steps: [], pendingQuestion: null })
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
