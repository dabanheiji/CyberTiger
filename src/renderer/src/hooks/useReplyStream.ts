import { useCallback, useEffect, useRef, useState } from 'react'
import type { IpcResult } from '../../../main/chat/dto'

/** 正在流式生成中的助手回复 */
export interface StreamingReply {
  conversationId: string
  messageId: string
  content: string
}

interface UseReplyStreamOptions {
  /** 生成结束(含手动停止)。返回 Promise 时会等其完成后再清空 streaming,避免气泡闪烁 */
  onDone: (conversationId: string, aborted: boolean) => void | Promise<void>
  onError: (conversationId: string, msg: string) => void | Promise<void>
}

interface UseReplyStreamResult {
  streaming: StreamingReply | null
  /** 触发模型生成回复,返回 IPC 结果;成功后开始接收流式事件 */
  start: (conversationId: string, model: string) => Promise<IpcResult<{ messageId: string }>>
  /** 中止当前生成 */
  abort: () => Promise<void>
}

/** 订阅主进程的 chat:stream 事件,维护当前流式回复的累计内容 */
export function useReplyStream(options: UseReplyStreamOptions): UseReplyStreamResult {
  const [streaming, setStreaming] = useState<StreamingReply | null>(null)
  // 事件监听器里读取最新值,避免闭包拿到过期 state
  const streamingRef = useRef<StreamingReply | null>(null)
  const optionsRef = useRef(options)

  useEffect(() => {
    optionsRef.current = options
  })

  const update = useCallback((next: StreamingReply | null): void => {
    streamingRef.current = next
    setStreaming(next)
  }, [])

  useEffect(() => {
    const unsubscribe = window.api.chat.onStream(async (event) => {
      const current = streamingRef.current
      // 只处理当前这条回复的事件,过期事件直接丢弃
      if (!current || current.messageId !== event.messageId) return

      if (event.type === 'delta') {
        update({ ...current, content: current.content + event.content })
        return
      }
      if (event.type === 'done') {
        await optionsRef.current.onDone(event.conversationId, event.aborted)
      } else {
        await optionsRef.current.onError(event.conversationId, event.msg)
      }
      // 回调里通常会重新拉取消息,拉完再清空,列表里已有落库内容接替显示
      if (streamingRef.current?.messageId === event.messageId) update(null)
    })
    return unsubscribe
  }, [update])

  const start = useCallback(
    async (
      conversationId: string,
      model: string
    ): Promise<IpcResult<{ messageId: string }>> => {
      const res = await window.api.chat.generateReply({ conversationId, model })
      if (res.success) {
        update({ conversationId, messageId: res.data.messageId, content: '' })
      }
      return res
    },
    [update]
  )

  const abort = useCallback(async (): Promise<void> => {
    const current = streamingRef.current
    if (!current) return
    await window.api.chat.abortReply(current.messageId)
  }, [])

  return { streaming, start, abort }
}
