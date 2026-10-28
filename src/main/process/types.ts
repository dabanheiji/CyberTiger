import type { ExecLaunch } from '../sandbox'

/**
 * 一次进程调用的死法。
 *
 * `exited` 是命令自己结束(退出码是什么都算);另外三种都是被外力打断,
 * 调用方要据此说清「超时 / 用户 / 起不来」,而不是把它们报成命令自身的故障。
 */
export type ExitKind = 'exited' | 'timeout' | 'aborted' | 'spawn-error'

/**
 * 输出接到哪儿去。
 *
 * `pipe` 收进内存,给前台命令;`file` 直接交给内核写,给后台作业 ——
 * 后台进程只要还攥着一条管道,收尾就永远等不到 `close`,那正是「跑一个服务就卡住」的根因。
 */
export type ProcIo = { kind: 'pipe' } | { kind: 'file'; fd: number }

/**
 * 输出收集器:两条流怎么合、留下多少由调用方决定。
 *
 * 省略即 `MergedSink`(合成一条、保头保尾)。钩子那条路径换成 `BufferSink`,要的正是
 * 「原始 stdout,要么完整要么作废」:`[stderr] ` 前缀会污染 JSON,而 `OutputSink` 那种
 * 从中间挖洞的裁剪会把一份 MB 级回执劈成解析不了的半截 —— 半截 JSON 不是「短一点的结论」,
 * 是「没有结论」。
 */
export interface ProcSink {
  pushStdout(text: string): void
  pushStderr(text: string): void
  bill(): OutputBill
}

export interface ProcSpec {
  /** 模型写下的那条命令;一个字都不改,审批的放行键算的就是它 */
  command: string
  cwd: string
  /** 受限执行的启动器;给定时命令串进 argv,拼进命令串会改掉放行键 */
  launch?: ExecLaunch
  /** 省略即收进内存 */
  io?: ProcIo
  /** 省略即不限时:后台作业靠它常驻,前台一律给值 */
  timeoutMs?: number
  signal?: AbortSignal
  /** 附加的环境变量(后台作业的归属标记),与 launch.env 合并 */
  env?: NodeJS.ProcessEnv
  /**
   * 要写进子进程 stdin 的内容;省略即 stdin 关闭。
   *
   * 那根管**只在给了这一句时才开**:关闭的 stdin 会让读输入的命令立刻拿到 EOF,
   * 而开着的管道一旦没人写,`cat` 不带参数、`read`、要确认的 `rm -i` 就永远等不到内容,
   * 只能拖到超时。所以默认那条纪律(见 spawnProc 里的 stdio)照旧,这里只是唯一的例外。
   */
  stdin?: string
  /**
   * 命令本身,argv 形状(第 0 项是可执行文件)。
   *
   * 钩子用它:参数不进 shell,于是没有二次分词与引号陷阱,带空格的参数就是原样一项。
   * 给了这一项就不再读 `command` 去拼载荷(那句只留给审批与日志看),
   * 有 `launch` 时这串 argv 接在启动器后面 —— seatbelt 是 `-p <profile> <program> <args>`、
   * bwrap 的参数以 `--` 收尾,两侧都是这个形状。
   */
  argv?: string[]
  /** 省略即 `MergedSink` */
  sink?: ProcSink
}

/** 输出账目:保头保尾,中间丢掉多少也记着 */
export interface OutputBill {
  head: string
  tail: string
  lines: number
  chars: number
  /** 被省掉的字符数,等于 `chars - head.length - tail.length` */
  dropped: number
}

export interface ProcOutcome {
  kind: ExitKind
  code: number | null
  signal: string
  output: OutputBill
  startedAt: number
  finishedAt: number
  /** 直接子进程退出后管道没在观察窗内关干净,是我们主动放弃等待 */
  drained: boolean
  /** 启动失败时的中文化说明;空串即启动成功 */
  spawnError: string
}
