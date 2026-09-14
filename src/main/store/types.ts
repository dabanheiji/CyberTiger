export interface AppSettings {
  baseUrl?: string
  apiKey?: string
  /** 已配置的模型 ID 列表，例如 qwen3.5:4b、deepseek-v4-flash */
  models?: string[]
  /** 聊天窗口当前选中的模型 ID */
  currentModel?: string
}
