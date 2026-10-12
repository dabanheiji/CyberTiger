import type { McpConfig } from '../mcp/types'

/** 上次退出时的窗口状态,用于启动还原 */
export interface WindowState {
  /** 普通(非最大化)状态下的窗口矩形 */
  bounds: { x: number; y: number; width: number; height: number }
  isMaximized: boolean
}

/**
 * 候选清单里的一行:模型 ID 加上它自己的上下文窗口。
 * 窗口配成对象字段而不是 Record<模型名, 窗口>:改名和删除时一起走,
 * 不会留下指向已删模型的悬空键。
 */
export interface ModelConfig {
  name: string
  /**
   * 该模型的上下文窗口(token),缺省按 DEFAULT_CONTEXT_WINDOW 算。
   * 这个值只参与裁剪预算的计算:配大了不会报错,只是要等真实上限撞上才发现
   * (本地运行时内存不足压小窗口时是静默截断,不返回错误)。
   */
  contextWindow?: number
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
  models: ModelConfig[]
}

/** 设置页新建 / 编辑服务商时提交的内容 */
export interface ModelProviderDraft {
  name: string
  baseUrl: string
  apiKey?: string
  models: ModelConfigDraft[]
}

/**
 * 表单里的模型行。清空窗口输入框时 antd 的 InputNumber 给的是 null,
 * 所以这里比 ModelConfig 宽一档,由提交方收敛成 undefined(= 用默认值)。
 */
export interface ModelConfigDraft {
  name: string
  contextWindow?: number | null
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
  /**
   * @deprecated 上下文窗口已经下放到每个模型(ModelConfig.contextWindow)。
   * 仅 migrateSettings 会读它并搬进当前选中的模型,新代码一律按模型取。
   */
  contextWindow?: number
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
