export interface createFirstMessageDto {
  content: string
  /** 通过 / 触发的 skill 名 */
  skill?: string
}

export interface sendMessageDto {
  conversationId: string
  content: string
  /** 通过 / 触发的 skill 名 */
  skill?: string
}

export interface renameConversationDto {
  conversationId: string
  title: string
}

export interface generateReplyDto {
  conversationId: string
  /**
   * 本次调用使用的服务商。
   * 省略时退回设置里上次选中的那个 —— 让一次 run 能自描述(调用方显式传),
   * 同时兼容不传的调用方。
   */
  providerId?: string
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

/**
 * 一次 agent run 的作用域。
 * 子 agent 复用父级的 runId(前端据此并进同一个气泡),靠 parentCallId / depth 挂到
 * 父级那次 task 工具调用下面。
 */
export interface RunScope {
  conversationId: string
  runId: string
  /** 角色名;'' 表示主 agent */
  agent: string
  /** 所属父级工具调用 id;'' 表示顶层 */
  parentCallId: string
  /** 0 = 主 agent,1 = 子 agent */
  depth: number
}

/** 主进程 → 渲染层 的流式事件,统一走 'chat:stream' 频道 */
export type ChatStreamEvent =
  /** Agent 新的一步开始:已插入一条空 assistant 行 */
  | { type: 'step_start'; scope: RunScope; messageId: string }
  /** 当前步的增量文本 */
  | { type: 'delta'; scope: RunScope; messageId: string; content: string; reasoning: string }
  /** 开始执行一个工具调用 */
  | { type: 'tool_call'; scope: RunScope; messageId: string; call: ToolCallRecord }
  /** 工具执行完毕,已插入 tool 行 */
  | {
      type: 'tool_result'
      scope: RunScope
      toolMessageId: string
      callId: string
      result: string
      ok: boolean
      /**
       * 本次调用命中了同一 run 内的去重缓存(没有真正执行工具)。
       * 仅用于界面提示;历史回放时无法还原,会退回普通的"已完成"。
       */
      reused?: boolean
    }
  /** 最外层 run 结束,aborted 为 true 表示用户手动停止;子 agent 不发此事件 */
  | { type: 'done'; scope: RunScope; aborted: boolean }
  /** 最外层 run 失败;子 agent 的失败由父级 task 的 tool_result(ok=false)表达 */
  | { type: 'error'; scope: RunScope; msg: string }

/** IPC handler 的统一返回结构 */
export type IpcResult<T> = { success: true; data: T } | { success: false; msg: string }
