import type { McpConfig } from '../mcp/types'

/** 上次退出时的窗口状态,用于启动还原 */
export interface WindowState {
  /** 普通(非最大化)状态下的窗口矩形 */
  bounds: { x: number; y: number; width: number; height: number }
  isMaximized: boolean
}

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
  /** 窗口大小/位置,由主进程维护,渲染层不使用 */
  windowState?: WindowState
}
