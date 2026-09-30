import type { McpConfig } from '../mcp/types'

export interface AppSettings {
  baseUrl?: string
  apiKey?: string
  /** 已配置的模型 ID 列表，例如 qwen3.5:4b、deepseek-v4-flash */
  models?: string[]
  /** 聊天窗口当前选中的模型 ID */
  currentModel?: string
  /** MCP server 配置,与 Claude Desktop 格式兼容 */
  mcpServers?: McpConfig
  /** 已禁用的 skill 名称 */
  disabledSkills?: string[]
  /** 下载私有仓库 skill 时使用;暂无设置 UI */
  githubToken?: string
}
