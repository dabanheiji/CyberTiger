import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApprovalRequest, IpcResult, PendingApprovalDto } from '../../../main/chat/dto'
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
  /**
   * 有值就是模型正等着用户批准一次操作(run 阻塞在那次工具执行上)。
   * 与 pendingQuestion 同一条纪律:收起它的时机是同一次调用的 tool_result,不是按下按钮那次。
   */
  pendingApproval: ApprovalRequest | null
}

interface UseAgentStreamOptions {
  /** run 结束(含手动停止)。返回 Promise 时会等其完成后再清空 streaming,避免气泡闪烁 */
  onDone: (conversationId: string, aborted: boolean) => void | Promise<void>
  onError: (conversationId: string, msg: string) => void | Promise<void>
}

interface UseAgentStreamResult {
  streaming: StreamingRun | null
  /**
   * 不属于界面上正在跟踪的那个 run 的审批请求。
   *
   * 渲染层重载(Cmd+R)之后事件订阅是新的、流式状态也归零,而主进程那一边仍然阻塞在一次
   * 工具执行上 —— 那时界面上没有任何地方能回答它。靠主进程的等待表把卡片填回来。
   */
  detachedApproval: PendingApprovalDto | null
  /** 启动 Agent run,返回 IPC 结果;成功后开始接收流式事件 */
  start: (conversationId: string, ref: ModelRef) => Promise<IpcResult<{ runId: string }>>
  /** 中止当前 run */
  abort: () => Promise<void>
  /**
   * 重读一次主进程的等待表。
   * 挂载、切会话、以及把决定送出去之后各调一次:后一次让卡片立刻收起,
   * 不等那次 tool_result —— 审批已了结这件事本身就是等待表里没这条的原因。
   */
  refreshApprovals: (conversationId: string) => Promise<void>
}

/**
 * 订阅主进程的 chat:stream 事件,维护当前 run 的各步累计状态。
 * 子 Agent 的事件带 parentCallId,会挂到发起它的那次 task 调用下面,形成嵌套结构。
 */
export function useAgentStream(options: UseAgentStreamOptions): UseAgentStreamResult {
  const [streaming, setStreaming] = useState<StreamingRun | null>(null)
  // 等待表里读来的、当前界面没法挂到流式状态上的那条审批(见 UseAgentStreamResult 注释)
  const [detachedApproval, setDetachedApproval] = useState<PendingApprovalDto | null>(null)
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
              current.pendingQuestion?.callId === event.callId ? null : current.pendingQuestion,
            // 审批同理:批没批、超时还是中止,那次调用的结果一到,卡片就没有留下的理由
            pendingApproval:
              current.pendingApproval?.callId === event.callId ? null : current.pendingApproval
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
        case 'tool_approval':
          // 这条 case 与 compact 一样是承重的:落到 switch 末尾会把整轮流式状态清空。
          // 卡片的内容由事件直接给出(主进程那边已经把判定算好了),不等 IPC 回读。
          update({ ...current, pendingApproval: event.request })
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
        update({
          conversationId,
          runId: res.data.runId,
          steps: [],
          pendingQuestion: null,
          pendingApproval: null
        })
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

  const refreshApprovals = useCallback(
    async (conversationId: string): Promise<void> => {
      const res = await window.api.chat.pendingApprovals()
      if (!res.success) return
      const hit = res.data.find((item) => item.conversationId === conversationId) ?? null
      const current = streamingRef.current
      if (current?.conversationId === conversationId) {
        // 这一轮界面上还在跟:卡片以事件流写进 pendingApproval 的那份为准,这里只补漏
        if (hit && !current.pendingApproval) update({ ...current, pendingApproval: hit })
        else if (!hit && current.pendingApproval) update({ ...current, pendingApproval: null })
        setDetachedApproval(null)
        return
      }
      setDetachedApproval(hit)
    },
    [update]
  )

  return { streaming, detachedApproval, start, abort, refreshApprovals }
}
