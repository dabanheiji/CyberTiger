import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { describeFsError } from '../tools/paths'
import { killGroup, killTree } from './kill'
import { MergedSink } from './sink'
import type { ExitKind, ProcOutcome, ProcSink, ProcSpec } from './types'

/** SIGTERM 之后再多等这么久就 SIGKILL:拖着不退的进程不能占着整轮 */
export const KILL_GRACE_MS = 1_000

/**
 * 从这里起无条件收场。
 *
 * SIGKILL 之后还有「杀不掉」的情形(D 状态、权限不足、Windows 上 taskkill 失败),
 * 而 `await` 一旦挂在这里,整个 run 就再也收不了尾 —— 会话会一直停在「有进行中的 run」。
 */
export const HARD_STOP_MS = 2_500

/**
 * 直接子进程退出后,给管道这么久把剩余数据吐干净。
 *
 * 前台命令里写 `server &` 时,bash 退出而服务还攥着 stdout —— 没有这个观察窗,
 * `'close'` 永不触发,一次普通调用就会拖到超时。观察窗过后连整组一起带走。
 */
export const DRAIN_MS = 250

/**
 * POSIX 下显式用 /bin/bash:模型写的命令常带 bash 写法,而 Linux 的 /bin/sh 往往是 dash,
 * 会莫名报语法错误。Windows 交给 Node 的默认 shell(cmd.exe)。
 */
const SHELL: string | boolean = process.platform === 'win32' ? true : '/bin/bash'

/** 受限执行那一支用的 shell:启动器后面要跟的是 **argv**,不能再交给 Node 的 `shell` 选项拼串 */
const POSIX_SHELL = '/bin/bash'

export function spawnProc(spec: ProcSpec): ChildProcess {
  const io = spec.io ?? { kind: 'pipe' }
  const argv = spec.argv && spec.argv.length > 0 ? spec.argv : undefined
  // 受限与不受限是两条 spawn:不受限那一支连一个字节都不该变(它的 `shell: SHELL` 语义、
  // 环境继承、cmd.exe 的行为都是既有单测钉住的),所以差别只写在这一份 spec 里。
  // 启动器进 argv 而不是拼进命令串:审批的放行键算的是命令本身,拼串会把那道判定一起改掉。
  // 第三支是钩子那种「命令本身就是 argv」:不能让 bash 再解析一遍参数,也不再拼 POSIX_SHELL。
  const base = argv
    ? {
        file: spec.launch ? spec.launch.file : argv[0],
        args: spec.launch ? [...spec.launch.args, ...argv] : argv.slice(1),
        shell: false as const,
        env: spec.launch
          ? { ...spec.launch.env, ...spec.env }
          : spec.env
            ? { ...process.env, ...spec.env }
            : undefined
      }
    : spec.launch
      ? {
          file: spec.launch.file,
          args: [...spec.launch.args, POSIX_SHELL, '-c', spec.command],
          shell: false as const,
          env: { ...spec.launch.env, ...spec.env }
        }
      : {
          file: spec.command,
          args: [] as string[],
          shell: SHELL,
          env: spec.env ? { ...process.env, ...spec.env } : undefined
        }
  return spawn(base.file, base.args, {
    cwd: spec.cwd,
    // stdin 默认 ignore:命令里只要有读输入的动作(cat 不带参数、read、要确认的 rm -i),
    // 管道会永远等不到内容,只能拖到超时才退。只有显式给了 stdin 才开那根管。
    stdio:
      io.kind === 'file'
        ? ['ignore', io.fd, io.fd]
        : [spec.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
    shell: base.shell,
    env: base.env
  })
}

/**
 * 跑一条命令并等它收场。
 *
 * 三条死法都必须有结论:正常结束(可能带一堆攥着管道的孙子进程)、被我们打断
 * (超时 / 中止)、根本没起来(cwd 不存在)。前两条原本挂在 `'close'` 一个事件上,
 * 而 `'close'` 要求**所有** stdio 都关上 —— 后台服务一攥管道,它就永远不来。
 */
export function runProcess(spec: ProcSpec): Promise<ProcOutcome> {
  const startedAt = Date.now()
  // 省略 sink 就是前台那条老路:两条流合成一条、保头保尾。钩子换成 BufferSink,
  // 要的是原始 stdout,而 outcome.output 那份账目跟着它一起变(见 sink.ts 里那段注释)。
  const sink: ProcSink = spec.sink ?? new MergedSink()

  // 中止先于启动:一条命令都不该跑出去,也不该留个马上就死的子进程让收尾去分辨
  if (spec.signal?.aborted) {
    return Promise.resolve({
      kind: 'aborted',
      code: null,
      signal: '',
      output: sink.bill(),
      startedAt,
      finishedAt: Date.now(),
      drained: false,
      spawnError: ''
    })
  }

  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawnProc(spec)
    } catch (error) {
      resolve({
        kind: 'spawn-error',
        code: null,
        signal: '',
        output: sink.bill(),
        startedAt,
        finishedAt: Date.now(),
        drained: false,
        spawnError: describeFsError(error)
      })
      return
    }

    // stdin 那根管只在给了内容时才开着(见 spawnProc)。'error' 必须接:钩子脚本读一半就退出时,
    // 这次写入会以 EPIPE 回来,而没监听者的 'error' 直接抛给 uncaughtException ——
    // 那就是把一个钩子的毛病变成整个应用崩溃。MB 级载荷交给 Node 的背压,不手工分块。
    if (spec.stdin !== undefined && child.stdin) {
      const input = child.stdin
      input.on('error', () => {})
      input.end(spec.stdin)
    }

    let kind: ExitKind = 'exited'
    let exitInfo: { code: number | null; signal: string } | undefined
    let spawnError = ''
    let drained = false
    let finalized = false
    let deadlineTimer: NodeJS.Timeout | undefined
    let graceTimer: NodeJS.Timeout | undefined
    let hardTimer: NodeJS.Timeout | undefined
    let drainTimer: NodeJS.Timeout | undefined

    const finalize = (): void => {
      if (finalized) return
      finalized = true
      if (deadlineTimer) clearTimeout(deadlineTimer)
      if (graceTimer) clearTimeout(graceTimer)
      if (hardTimer) clearTimeout(hardTimer)
      if (drainTimer) clearTimeout(drainTimer)
      spec.signal?.removeEventListener('abort', onAbort)
      resolve({
        kind,
        code: exitInfo?.code ?? null,
        signal: exitInfo?.signal ?? '',
        output: sink.bill(),
        startedAt,
        finishedAt: Date.now(),
        drained,
        spawnError
      })
    }

    const terminate = (reason: 'timeout' | 'aborted'): void => {
      // 已经退出 / 已经在收尾:再杀一次只会把结论改错 —— 一次正常结束不该被报成「用户中止」
      if (finalized || exitInfo) return
      kind = reason
      killTree(child, 'SIGTERM')
      graceTimer = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS)
      hardTimer = setTimeout(() => {
        drained = true
        finalize()
      }, HARD_STOP_MS)
    }

    const onAbort = (): void => terminate('aborted')

    if (spec.timeoutMs !== undefined) {
      deadlineTimer = setTimeout(() => terminate('timeout'), spec.timeoutMs)
    }
    spec.signal?.addEventListener('abort', onAbort, { once: true })

    // spawn 失败(如 cwd 不存在)只发 error、不会有 close,必须自己收尾
    child.on('error', (error) => {
      if (!exitInfo) {
        spawnError = describeFsError(error)
        kind = 'spawn-error'
      }
      finalize()
    })

    child.on('exit', (code, signalName) => {
      if (finalized) return
      exitInfo = { code, signal: signalName ?? '' }
      // 后台作业的输出接在文件上,没有管子可等人关:直接子进程走了就是走了
      if (spec.io?.kind === 'file') {
        finalize()
        return
      }
      drainTimer = setTimeout(() => {
        drained = true
        killGroup(child.pid ?? 0, 'SIGTERM')
        child.stdout?.destroy()
        child.stderr?.destroy()
        finalize()
      }, DRAIN_MS)
    })

    child.on('close', (code, signalName) => {
      if (finalized) return
      exitInfo = { code, signal: signalName ?? '' }
      finalize()
    })

    if (spec.io?.kind !== 'file') {
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => sink.pushStdout(chunk))
      child.stderr?.on('data', (chunk: string) => sink.pushStderr(chunk))
    }
  })
}
