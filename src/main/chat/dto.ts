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
 * 一步模型调用的 token 用量。
 * 端点上报的真实值与本地估算值共用同一形状,靠 estimated 区分来源 ——
 * 界面要据此决定显示「12.3k」还是「≈12.3k」。
 */
export interface TokenUsage {
  prompt: number
  completion: number
  /** true 表示端点没报 usage,本值是 tokens/estimate 估出来的 */
  estimated: boolean
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

/**
 * 一次请求的上下文占用情况,由 agent/context.ts 在裁剪后给出。
 * 与用量事件一起发,界面才能显示「这条回复是在多满的窗口里产出的」。
 */
export interface ContextMeter {
  /** 输入侧预算:窗口大小已扣除安全边界与输出预留 */
  budget: number
  /** 为塞进预算而整轮丢弃的历史轮数 */
  droppedTurns: number
  /** 在最近一轮内部弃掉的消息条数(长工具链的较早步骤) */
  droppedMessages: number
  /** 为塞进预算而被就地缩写的消息条数 */
  shrunkMessages: number
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
  /**
   * 一步结束时的 token 用量与上下文占用(与 assistant 行一一对应)。
   * 子 agent 同样发:它的成本要能并进父级气泡的总量,而不是凭空消失。
   */
  | {
      type: 'usage'
      scope: RunScope
      messageId: string
      usage: TokenUsage
      context: ContextMeter
    }
  /** 最外层 run 结束,aborted 为 true 表示用户手动停止;子 agent 不发此事件 */
  | { type: 'done'; scope: RunScope; aborted: boolean }
  /** 最外层 run 失败;子 agent 的失败由父级 task 的 tool_result(ok=false)表达 */
  | { type: 'error'; scope: RunScope; msg: string }

/** IPC handler 的统一返回结构 */
export type IpcResult<T> = { success: true; data: T } | { success: false; msg: string }
