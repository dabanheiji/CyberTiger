import type { McpConfig } from '../mcp/types'

/** 上次退出时的窗口状态,用于启动还原 */
export interface WindowState {
  /** 普通(非最大化)状态下的窗口矩形 */
  bounds: { x: number; y: number; width: number; height: number }
  isMaximized: boolean
}

/** 一个模型服务商:独立的接口地址与凭据,下挂自己的模型清单 */
export interface ModelProvider {
  /** uuid;改名不影响已被引用的地方 */
  id: string
  /** 展示名,也是 AGENT.md 里引用服务商用的名字 —— 全局唯一 */
  name: string
  baseUrl: string
  apiKey?: string
  /**
   * 给选择器用的候选清单,不是白名单:
   * 服务端支持哪些模型由服务端说了算,运行时不再校验。
   */
  models: string[]
}

/** 设置页新建 / 编辑服务商时提交的内容 */
export interface ModelProviderDraft {
  name: string
  baseUrl: string
  apiKey?: string
  models: string[]
}

/** 一次模型调用的选择 */
export interface ModelRef {
  providerId: string
  model: string
}

export interface AppSettings {
  /** 模型服务商列表 */
  providers?: ModelProvider[]
  /** 上次使用的模型;只用于初始化选择器,单次 run 以调用方传入的引用为准 */
  currentModel?: ModelRef
  /** MCP server 配置,与 Claude Desktop 格式兼容 */
  mcpServers?: McpConfig
  /** 已禁用的 skill 名称 */
  disabledSkills?: string[]
  /** 已禁用的自定义子 Agent 角色名 */
  disabledAgents?: string[]
  /** 是否允许主 Agent 派生子 Agent;未设置视为允许 */
  enableSubAgent?: boolean
  /** 下载私有仓库 skill 时使用;暂无设置 UI */
  githubToken?: string
  /** 窗口大小/位置,由主进程维护,渲染层不使用 */
  windowState?: WindowState

  /**
   * @deprecated 单服务商时代的全局连接信息,已由 migrateSettings 搬进 providers。
   * 仅迁移代码会读,新代码一律走 providers。
   */
  baseUrl?: string
  /** @deprecated 见 baseUrl */
  apiKey?: string
  /** @deprecated 见 baseUrl */
  models?: string[]
}
