/** 子 Agent 角色的来源 */
export type AgentSource = 'builtin' | 'custom'

/** 一个可被 task 工具指定的子 Agent 角色 */
export interface AgentMeta {
  name: string
  description: string
  /** 自定义角色的目录绝对路径;内置角色为空串 */
  dir: string
  /** 正文,即该角色的 system prompt */
  systemPrompt: string
  /** 可选:指定服务商(按名字引用);缺省沿用父级那家 */
  provider?: string
  /** 可选:覆盖父级使用的模型;缺省继承(指定了 provider 时取该服务商的首个模型) */
  model?: string
  /** 可选:工具白名单;缺省继承父级全部工具(不含 task) */
  tools?: string[]
  /** 内置角色由代码定义,设置页只读且不可删除 */
  builtin?: boolean
  enabled: boolean
  /** AGENT.md 解析失败时的原因;存在时 enabled 固定为 false */
  error?: string
}

/** 设置页新建 / 编辑角色时提交的内容 */
export interface AgentDraft {
  name: string
  description: string
  systemPrompt: string
  provider?: string
  model?: string
  tools?: string[]
}

/** 工具白名单多选的候选项 */
export interface AgentToolOption {
  name: string
  description: string
  /** 展示用的来源标注:内置 / MCP */
  source: string
}
