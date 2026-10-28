import type { HookEvent, HookMeta } from './types'

/**
 * 钩子的跨进程契约:设置页读的那一行执行记录,与 `hooks:list` 回读的那一份声明。
 *
 * 这里刻意**没有**对话正文。`beforeRequest` 的 payload 里有整份出站消息,而它们一次都不写进
 * `logs/hooks.jsonl`(见 `log.ts`),所以这份 DTO 里没有可写的东西 —— 只写结论与条数。
 */

/**
 * 一次触发的处置。六个值各自说一件事,两两不重叠:
 *
 * - `blocked` 否决了本轮 / 这次调用
 * - `adopted` 有内容被采纳(追加了说明,或改写被接受)
 * - `noop` 跑完了,回执合法但没有任何可采纳的东西
 * - `rejected` 回执合法,但那份改写没过结构守卫(其余字段仍可能已采纳)
 * - `skipped` 根本没跑:边界建不出来,或 payload 大得不该进管道
 * - `failed` 跑了但没结论:起不来、超时、被中止、输出不是 JSON
 */
export type HookDecision = 'blocked' | 'adopted' | 'noop' | 'rejected' | 'skipped' | 'failed'

/** `failed` 与 `skipped` 那两类的具体来由;界面上「最近执行」按这一格决定说什么 */
export type HookFailure =
  | 'spawn-error'
  | 'timeout'
  | 'aborted'
  | 'bad-output'
  | 'payload-too-large'
  | 'no-boundary'
  /** 改写没守卫过 —— 不是钩子失败,是那份改写没被采纳,单列一个值让「最近执行」说得出原因 */
  | 'rewrite-rejected'

/** `logs/hooks.jsonl` 的一行,也是设置页「最近执行」那张表的一行 */
export interface HookExecution {
  /** ISO 文本:这份文件是给人翻的,不需要与 messages 的 UTC 列同一种写法 */
  ts: string
  event: HookEvent
  hook: string
  conversationId: string
  runId: string
  /** 角色名;'' 表示主 Agent */
  agent: string
  depth: number
  /** 触发时所在步;run 级事件是 0 */
  step: number
  decision: HookDecision
  /** 否决理由(给模型看的那句) */
  reason?: string
  /** 追加给模型的说明 */
  note?: string
  rewritten?: boolean
  /** 改写被采纳时那份请求的消息条数 —— 只记条数,不记内容 */
  msgCount?: number
  /** 这个事件不读的键,例如 `afterAgent` 给了 `block` */
  ignored?: string[]
  failure?: HookFailure
  /** 非 0 退出码:它是「命令自己说不行」的信号,与 `failure` 一起才说得清那一次 */
  exit?: number | null
  ms: number
  /** stdout 片段,只在 `bad-output` 时有(最多 2000 字);不是完整回执 */
  out?: string
  /** stderr 片段或中文化的错误 */
  err?: string
  /** `skipped` 的可见理由 */
  why?: string
  /**
   * 钩子自己写下的那句只进日志的话(`message` 键),以及本地丢东西时的说明
   * (本步说明已达上限、改写没过守卫)。
   *
   * 它和 `reason` / `note` 的区别是受众:`reason` 与 `note` 是给模型看的,这一格只给**人**看。
   * 钩子最常见的用法是「报个进度」,而那种话进模型上下文等于往每步请求里塞噪声。
   */
  log?: string
}

/**
 * `hooks:list` 的一行:声明本身,加上两件界面自己算不出来的事。
 *
 * - `resolvedPath`:`command` 写成相对路径时那条路在磁盘上的真身。写错目录的失败只有一行
 *   `ENOENT` 日志,而用户看不见失败原因就等于钩子凭空失灵,所以界面上直接把解析结果摆出来。
 * - `runsAs`:这一条**现在**真的跑在哪一侧。Windows 上写死「已启用沙箱」就是说谎,
 *   所以这一格必须由主进程按当前沙箱状态与这台机器的机制算,而不是照声明里的 `sandboxed` 抄。
 */
export interface HookRow {
  meta: HookMeta
  /** 声明解析失败的原因;有这一格时该条不可启用 */
  error?: string
  resolvedPath: string
  runsAs: string
}
