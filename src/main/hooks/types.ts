/**
 * 钩子域的词汇表。
 *
 * 这一层没有 electron、没有文件系统、没有子进程,所以设置页与主进程可以共用同一批名字,
 * 而不会出现「界面上叫 before、代码里叫 pre」那种两套词汇对不上的事。
 */

/**
 * 六个触发时机。
 *
 * `before*` 有三个权利:否决、追加说明、(只有 `beforeRequest`)改写即将发出的请求;
 * `after*` 只有追加说明 —— 给「事后改写」开口子等于让钩子伪造已经发生过的事实,
 * 那与拦下一件事、补充一句背景不在同一个风险级别上。
 */
export type HookEvent =
  | 'beforeAgent'
  | 'beforeRequest'
  | 'afterRequest'
  | 'beforeToolCall'
  | 'afterToolCall'
  | 'afterAgent'

/** 声明里的 `event` 只认这六个字面量;解析失败时把这份清单原样报给用户 */
export const HOOK_EVENTS: readonly HookEvent[] = [
  'beforeAgent',
  'afterAgent',
  'beforeRequest',
  'afterRequest',
  'beforeToolCall',
  'afterToolCall'
]

/** 一次触发时写进子进程 stdin 的那个 JSON 的版本号 */
export const HOOK_CONTRACT_VERSION = 1

/**
 * `HOOK.md` 的 frontmatter 解析结果 —— 也就是磁盘上的那一份声明。
 *
 * 一个文件只声明一个事件:两种形状(一个文件挂多个事件、一个事件挂多个命令)都会让
 * 「这条钩子什么时候跑」变成要把两层数组交叉读一遍才懂的事,而目录扫描本来就是按条算的。
 */
export interface HookMeta {
  /** 必须与目录名一致:目录是身份,重命名等于换一条钩子 */
  name: string
  description: string
  event: HookEvent
  /** 用户写下的那一条,界面上原样显示;真正的可执行文件由 `resolveHookCommand` 算 */
  command: string
  args: string[]
  /** 仅 `beforeToolCall` / `afterToolCall` 读;其余事件上给了会被忽略并记一行 */
  matcher: string[]
  /** 默认 false —— 钩子是按用户全权限跑的用户自己的程序,开了才进那道边界 */
  sandboxed: boolean
  /** 毫秒;缺省 10000,上限 60000 */
  timeoutMs: number
  /** 仅 `beforeRequest` 读:一个 run 只在第 1 步触发一次 */
  once: boolean
  /** 给人看的正文,不进 payload、不进模型上下文 */
  doc: string
  /** 钩子目录的绝对路径;`command` 的相对路径与进程 cwd 都以它为基准 */
  dir: string
  enabled: boolean
  /**
   * 声明解析失败的原因。有这一格时该条**永不触发**(`getEnabled` 直接滤掉),
   * 界面上显示的就是这一句 —— 让它从列表里消失等于用户不知道自己装的那条坏了。
   * 此时 `event` / `command` 是占位值,只为让类型保持完整,不参与任何判定。
   */
  error?: string
}

/** 设置页新建 / 编辑时提交的内容;与 HookMeta 的差别只有「还没落到某个目录」 */
export interface HookDraft {
  name: string
  description: string
  event: HookEvent
  command: string
  args?: string[]
  matcher?: string[]
  sandboxed?: boolean
  timeout?: number
  once?: boolean
  doc?: string
}

/**
 * 一次触发的结论。
 *
 * 四个字段各自说一件事,互不隐含:`block` 要不要拦、`reason` 拦的理由、`note` 补给模型的一句、
 * `rewrite` 那份改写后的出站消息。`log` 是唯一一条模型永远看不到的话,只进日志。
 */
export interface HookReply {
  block: boolean
  /** 给模型看的陈述句;`block` 为真而它为空时用默认那句 */
  reason: string
  /** 给模型看的补充说明 */
  note: string
  /** 仅 `beforeRequest` 采纳,且还要过 `guard.ts` 的五步守卫 */
  rewrite: unknown[] | null
  /** 只进日志,永不进模型可见文本 */
  log: string
  /** 这个事件不读的键(比如 `afterAgent` 给了 `block`),记一行而不是悄悄吞掉 */
  ignored: string[]
  /** 空串即回执可用;非空就是「这次没有结论」的原因 */
  problem: string
  /** 非 0 退出码但 stdout 仍是合法回执时照它,所以这个值要一路带到日志 */
  exitCode: number | null
  /**
   * 只进日志的一段原文:解析失败时是 stdout,没有输出时是 stderr。
   *
   * 钩子失败的排查全靠这一格 —— 界面上「最近执行」那一行点开看到的就是它,
   * 而 `problem` 只说「为什么算失败」,说不出「它到底印了什么」。
   */
  out: string
}
