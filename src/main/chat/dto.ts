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

/** 模型发起的一次工具调用(存库与传输共用) */
export interface ToolCallRecord {
  id: string
  name: string
  /** 模型给出的原始 JSON 字符串,可能不合法 */
  arguments: string
}

/** 主进程 → 渲染层 的流式事件,统一走 'chat:stream' 频道 */
export type ChatStreamEvent =
  /** Agent 新的一步开始:已插入一条空 assistant 行 */
  | { type: 'step_start'; conversationId: string; runId: string; messageId: string }
  /** 当前步的增量文本 */
  | {
      type: 'delta'
      conversationId: string
      runId: string
      messageId: string
      content: string
      reasoning: string
    }
  /** 开始执行一个工具调用 */
  | {
      type: 'tool_call'
      conversationId: string
      runId: string
      messageId: string
      call: ToolCallRecord
    }
  /** 工具执行完毕,已插入 tool 行 */
  | {
      type: 'tool_result'
      conversationId: string
      runId: string
      toolMessageId: string
      callId: string
      result: string
      ok: boolean
    }
  /** 整个 run 结束,aborted 为 true 表示用户手动停止 */
  | { type: 'done'; conversationId: string; runId: string; aborted: boolean }
  /** 调用失败 */
  | { type: 'error'; conversationId: string; runId: string; msg: string }

/** IPC handler 的统一返回结构 */
export type IpcResult<T> = { success: true; data: T } | { success: false; msg: string }
