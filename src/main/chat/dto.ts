export interface createFirstMessageDto {
  content: string
}

export interface sendMessageDto {
  conversationId: string
  content: string
}

export interface renameConversationDto {
  conversationId: string
  title: string
}

export interface generateReplyDto {
  conversationId: string
  /** 本次调用使用的模型 ID */
  model: string
}

/** 主进程 → 渲染层 的流式事件,统一走 'chat:stream' 频道 */
export type ChatStreamEvent =
  /** 增量文本 */
  | { type: 'delta'; conversationId: string; messageId: string; content: string }
  /** 生成结束,aborted 为 true 表示用户手动停止 */
  | { type: 'done'; conversationId: string; messageId: string; aborted: boolean }
  /** 调用失败 */
  | { type: 'error'; conversationId: string; messageId: string; msg: string }

/** IPC handler 的统一返回结构 */
export type IpcResult<T> = { success: true; data: T } | { success: false; msg: string }
