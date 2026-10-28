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

/**
 * 明暗模式。`'system'` 是默认值,也是「不覆盖」的意思。
 * 由主进程写成 `nativeTheme.themeSource`,于是 CSS 的 `prefers-color-scheme` 与
 * `shouldUseDarkColors` 一起翻转,渲染层那套读 media query 的逻辑不用改。
 */
export type ThemeMode = 'system' | 'light' | 'dark'

/** 「外观」设置:整体一个键,子字段各自可选 */
export interface AppearanceSettings {
  /** 缺省即 `'system'` */
  mode?: ThemeMode
  /**
   * 强调色 `#RRGGBB`,明暗共用一个,深色下由渲染层按明度区间自动调亮。
   * 缺省即 `theme.ts` 的 `DEFAULT_ACCENT`(虎橙)。
   */
  accent?: string
}

/**
 * 三档权限模式。缺省 `'ask'` —— 未设置就是最严格那一档,和「配置文件里没有这一键」
 * 是同一个意思,所以不必进 defaults、也不必走迁移。
 */
export type PermissionMode = 'ask' | 'auto' | 'full'

/** 「权限」设置:与 `appearance` 同一条纪律,整体一个键写入,避免「mode 落了、名单没落」 */
export interface PermissionSettings {
  /** 缺省即 `'ask'`:每条命令与越界读写都弹审批 */
  mode?: PermissionMode
  /**
   * 白名单:命中即免审批。条目三种形状(命令前缀 / 工具名 / 以 `__` 结尾的 MCP server 前缀),
   * 解析规则的唯一实现在 `tools/permission.ts`。
   */
  allow?: string[]
  /**
   * 黑名单:命中必审批,**优先级高于白名单,也高于 `'full'`** ——
   * 它是唯一在任何档位都拦得住的闸门,所以「完全访问」也照样拦。
   */
  deny?: string[]
  /** 用户已在「完全访问」的风险确认里勾过「我已知晓,以后不再询问」 */
  acknowledgeFullAccess?: boolean
}

/**
 * 「沙箱」设置:写侧边界一颗、受限执行两颗。与 `appearance` / `permissions` 同一条纪律,
 * 整体一个键写入、不进 defaults、不走迁移。
 */
export interface SandboxSettings {
  /**
   * 缺省即**开**(选了工作空间的会话):与「缺键即最严」那条纪律一致 ——
   * 老用户的配置文件里没有这一键,而 jail 正是那道更严的护栏。
   * `false` 只关掉文件写入的边界约束,不影响审批。
   */
  enabled?: boolean
  /**
   * `run_command` 的 OS 级受限执行(mac 的 sandbox-exec / Linux 的 bwrap)。缺省即**开**,
   * 与 `enabled` 同一条纪律;`false` 只放开 shell,文件写入的边界仍然装着。
   * 两颗开关分开是因为「想让构建命令写到工作空间外」不该顺手把写侧护栏也关掉。
   * Windows 没有对应机制,这一颗在那台机器上不起作用(界面按预检结论明写)。
   */
  exec?: boolean
  /**
   * 受限执行里放不放行网络。缺省即**放行** —— 这一颗的方向与安全无关,是对「缺省即最保守」
   * 那条纪律的一次公开例外:装包、拉代码、curl 都靠它,关掉之后那些命令全挂。
   * 代价要在设置页写清:拦不住「把仓库内容外传」这条路,这道边界管文件,不管数据出境。
   */
  network?: boolean
}

/**
 * 这台机器上用哪种机制做受限执行。`'none'` 是**没有这种机制**(Windows),不是「起失败了」——
 * 消费者按 `engine` 分支,别按 `available` 分支,后者在 `'none'` 那一支也是 `true`。
 */
export type SandboxEngine = 'seatbelt' | 'bwrap' | 'none'

/**
 * `settings:sandboxStatus` 的载荷:引擎预检结论 + 平台。
 *
 * 放在这一层是因为它跨进程(`SandboxPanel` 要显示),与 `SandboxSettings` 同一个理由;
 * 生成它的逻辑在 `sandbox/preflight.ts`,那边只认这份类型的 `Omit<..., 'platform'>`。
 */
export interface SandboxExecStatus {
  platform: string
  engine: SandboxEngine
  /** false = 开着沙箱时 `run_command` 不执行,而不是静默退回不受限地跑 */
  available: boolean
  /** 面向用户的一句实话:不可用的原因,或「这台机器没有这种机制」 */
  reason?: string
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
  /**
   * 已禁用的钩子名。
   *
   * 启停不进 `HOOK.md` 而放这里:磁盘上写下声明即「用户要它」,而关掉一条是应用侧的状态,
   * 不该让用户去改自己写的文件。与 `disabledSkills` / `disabledAgents` 同一条纪律,
   * 不进 `defaults`、不走迁移(缺键即「没有关掉任何一条」)。
   */
  disabledHooks?: string[]
  /**
   * 新建会话默认使用的工作空间目录:草稿态(还没建会话)在选择器里挑的目录先落这里,
   * 首条消息建会话时由 service 抄进 conversations.workspace。已有会话一律读自己那一列。
   */
  defaultWorkspace?: string
  /** 最近用过的工作空间,最新在前;渲染层在选择器里列出来,点击即可切换 */
  workspaceRecent?: string[]
  /** 是否允许主 Agent 派生子 Agent;未设置视为允许 */
  enableSubAgent?: boolean
  /**
   * 外观:明暗模式与自定义强调色。未设置即跟随系统 + 默认强调色。
   * `mode` 由主进程在启动与写入时应用到 `nativeTheme`,`accent` 只在渲染层生效。
   */
  appearance?: AppearanceSettings
  /**
   * 工具执行审批:档位与黑白名单。未设置即 `'ask'` + 两份空名单。
   * 一次 run 开始时读一次并随整轮固定(收紧立即、放宽下一轮),详见 `chat/service.ts`。
   */
  permissions?: PermissionSettings
  /**
   * 文件路径 jail:写入限制在会话工作空间内。未设置即为开(见 `SandboxSettings`)。
   * 一次 run 开始时和 `workspace` 一起读一次,跑到一半换设置不影响这一轮。
   */
  sandbox?: SandboxSettings
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
