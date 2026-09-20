/** stdio 传输:启动本地进程 */
export interface McpStdioServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  disabled?: boolean
}

/** Streamable HTTP 传输:连接远程服务 */
export interface McpHttpServerConfig {
  url: string
  headers?: Record<string, string>
  disabled?: boolean
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig

/** 与 Claude Desktop 兼容的配置格式 */
export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>
}

export type McpServerState = 'disabled' | 'connecting' | 'connected' | 'error'

export interface McpToolInfo {
  name: string
  description?: string
}

export interface McpServerStatus {
  name: string
  state: McpServerState
  error?: string
  tools: McpToolInfo[]
}

export const DEFAULT_MCP_CONFIG: McpConfig = { mcpServers: {} }
