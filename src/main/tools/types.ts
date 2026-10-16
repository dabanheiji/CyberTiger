import type OpenAI from 'openai'

/** 一次工具调用的上下文,由 Agent loop 在调用点注入 */
export interface ToolContext {
  /**
   * 本次工具调用的 id。
   * task 工具靠它把派生出的子 agent 挂到"是哪一次 task 调用"下面(落库与流式事件都用),
   * ask_user 靠它让渲染层在同一次调用的结果到手时收起提问卡片。
   */
  callId: string
  /**
   * 本次 run 的中止信号。
   * 长耗时工具(shell 命令)靠它在用户点停止时杀掉子进程,否则 loop 已退出等待、
   * 子进程还在后台跑。省略时工具只能靠自己设的超时收尾。
   */
  signal?: AbortSignal
  /**
   * 本次会话的工作空间目录(空/省略表示用户没选)。
   * 文件工具据此解析相对路径,shell 工具拿它当缺省 cwd —— 一个 run 内在 startRun
   * 固定一次,父子 agent 共用同一份,免得中途换目录把已发出的相对路径变成另一套含义。
   */
  workspace?: string
}

/** 一个可供模型调用的本地工具 */
export interface ToolDefinition {
  /** 函数名,a-z A-Z 0-9 _ -,最长 64 */
  name: string
  /** 给模型看的说明,决定它何时调用 */
  description: string
  /** 参数的 JSON Schema */
  parameters: OpenAI.FunctionParameters
  /**
   * 结果是否随时间变化(时间、天气、实时数据等)。
   * 为 true 时,历史回放不再把旧结果给模型,避免模型复用过期数据而不重新调用。
   */
  volatile?: boolean
  /** 执行工具;返回给模型看的文本。抛错会被注册表捕获并转成错误说明 */
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<string> | string
}

export interface ToolExecResult {
  ok: boolean
  /** 回传给模型的文本;失败时是错误说明 */
  result: string
}
