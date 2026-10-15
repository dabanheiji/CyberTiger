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
  /** 为塞进预算而整轮丢弃的历史轮数(压缩生效时常态为 0,只在硬上限兜底时才不为 0) */
  droppedTurns: number
  /** 在最近一轮内部弃掉的消息条数(长工具链的较早步骤) */
  droppedMessages: number
  /** 为塞进预算而被就地缩写的消息条数 */
  shrunkMessages: number
  /** 摘要块自身占的输入 token;0 表示这个会话还没有摘要 */
  summaryTokens: number
}

/**
 * 一次上下文压缩的账目,JSON 存在 `conversations.summary_usage`。
 * 只用来解释「上次压了什么、省了多少、花多少」,不参与裁剪判断。
 */
export interface SummaryMetrics {
  /** 摘要那次调用的输入 token */
  prompt: number
  /** 摘要正文的 token 数 */
  completion: number
  /** 端点没报 usage 时上面两个数是本地估算值 */
  estimated: boolean
  /** 被摘要覆盖的消息条数 */
  coveredMessages: number
  /** 被摘要覆盖的原始 token 数:界面显示「省下 N」就是它 */
  coveredTokens: number
  /** 压缩发生的时刻(ISO 字符串) */
  at: string
}

/** 手动压缩一次会话上下文 */
export interface compactDto {
  conversationId: string
  /** 与 generateReply 同语义:省略时退回设置里上次选中的服务商 */
  providerId?: string
  model: string
}

/**
 * 切换会话的工作空间。
 * dir 为空串表示清除:工具退回按应用当前目录解析,与从没选过一致。
 */
export interface setWorkspaceDto {
  conversationId: string
  dir: string
}

/**
 * 压缩被计划拒绝的原因(与 agent/compact.ts 的 `CompactReason` 同一支,字面量联合结构相同)。
 * 界面要据此解释「现在按了也省不出空间」,所以它不是错误,是一个需要展示的结论。
 */
export type CompactRejectReason = 'below-trigger' | 'too-few-units' | 'poor-saving'

/**
 * 一次上下文压缩的结果,`chat:compactContext` 的返回值。
 * `compacted === false` 时水位一定没动,历史原样继续用。
 */
export interface CompactReport {
  compacted: boolean
  /** 计划直接拒绝压缩的原因(没越过触发线 / 可压的太少 / 省不出空间) */
  reason?: CompactRejectReason
  /** 摘要调用失败或被中止时面向用户的中文提示 */
  msg?: string
  /** 摘要那几次调用的 token 开销:压缩自己也要花 token,界面要能显示成本 */
  usage?: TokenUsage
  /** 压进了摘要的账目(条数 / token / 时刻) */
  metrics?: SummaryMetrics
  /** 压完的预计占用,供界面在按钮旁写「压完约 N」 */
  projectedTokens?: number
  /** 这次判断所依据的窗口大小 */
  window: number
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
  /**
   * run 中途做了一次上下文压缩:此前的历史被换成一份摘要,后续步骤从摘要 + 最新消息继续。
   * 挂在触发它的那一步上,界面据此说明「这条回复的后半段是在压缩后的上下文里写的」。
   * 手动压缩走 IPC 返回值,不发这个事件。
   */
  | {
      type: 'compact'
      scope: RunScope
      messageId: string
      /** false 表示摘要调用失败或被中止:水位没动,历史原样继续用 */
      ok: boolean
      usage: TokenUsage
      metrics?: SummaryMetrics
      msg?: string
    }
  /** 最外层 run 结束,aborted 为 true 表示用户手动停止;子 agent 不发此事件 */
  | { type: 'done'; scope: RunScope; aborted: boolean }
  /** 最外层 run 失败;子 agent 的失败由父级 task 的 tool_result(ok=false)表达 */
  | { type: 'error'; scope: RunScope; msg: string }

/** IPC handler 的统一返回结构 */
export type IpcResult<T> = { success: true; data: T } | { success: false; msg: string }
