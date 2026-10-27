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
