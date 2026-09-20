import type OpenAI from 'openai'

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
  execute: (args: Record<string, unknown>) => Promise<string> | string
}

export interface ToolExecResult {
  ok: boolean
  /** 回传给模型的文本;失败时是错误说明 */
  result: string
}
