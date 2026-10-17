import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { annotate, anchor, describeFsError } from './paths'
import type { ExecBoundary, ExecLaunch } from '../sandbox'
import type { ToolDefinition } from './types'

const DEFAULT_TIMEOUT_SECONDS = 30
const MAX_TIMEOUT_SECONDS = 600

/** stdout / stderr 各自的字符上限;超了保留末尾 —— 命令的报错通常最后才出现 */
const MAX_OUTPUT_CHARS = 16_000

/** SIGTERM 之后再多等这么久就 SIGKILL,拖着不退的进程不能占着整轮 */
const KILL_GRACE_MS = 1_000

/**
 * POSIX 下显式用 /bin/bash:模型写的命令常带 bash 写法,而 Linux 的 /bin/sh 往往是 dash,
 * 会莫名报语法错误。Windows 交给 Node 的默认 shell(cmd.exe)。
 */
const SHELL: string | boolean = process.platform === 'win32' ? true : '/bin/bash'

/** 受限执行那一支用的 shell:启动器后面要跟的是** argv**,不能再交给 Node 的 `shell` 选项拼串 */
const POSIX_SHELL = '/bin/bash'

/**
 * 边界造成的失败长什么样。
 *
 * 只匹配这几句:内核给的 EPERM/EROFS 与命令自己的故障在退出码上分不出来,而模型读到
 * 「No such file or directory」这类太常见的报错会跟着往错误的方向找原因,所以那句不进匹配。
 */
const BOUNDARY_FAILURES =
  /Operation not permitted|Permission denied|Read-only file system|Network is unreachable|Temporary failure in name resolution/

interface StreamSink {
  text: string
  omittedChars: number
}

/** 边收边截断:只留末尾那么长,不指望进程自己先停下来 */
function attachSink(stream: NodeJS.ReadableStream | null, sink: StreamSink): void {
  if (!stream) return
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    sink.text += chunk
    if (sink.text.length > MAX_OUTPUT_CHARS) {
      const excess = sink.text.length - MAX_OUTPUT_CHARS
      sink.text = sink.text.slice(excess)
      sink.omittedChars += excess
    }
  })
}

/**
 * 杀进程:POSIX 下按进程组杀,命令里再起的孙子进程(sleep、管道下游)才不会被留下。
 *
 * 套上启动器之后这一条**两个平台都原样成立**(实测):mac 的 `sandbox-exec` 是 `exec`,
 * 不换进程组,`$$` 就是 `child.pid`;Linux 的 bwrap 虽然 fork,但子进程与它同组,
 * 加上 `--die-with-parent` 与 `--unshare-pid` 后整棵树一起退。所以既不用改杀法,
 * 也不用把启动器的 pid 单独记一份。
 */
function killTree(child: ChildProcess, mode: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, mode)
    else child.kill(mode)
  } catch {
    // 进程已经退了,没有要杀的
  }
}

interface ShellRun {
  exitCode: number | null
  signalName: string
  stdout: StreamSink
  stderr: StreamSink
  timedOut: boolean
  aborted: boolean
  spawnError: string
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  launch?: ExecLaunch
): Promise<ShellRun> {
  return new Promise((resolve) => {
    const run: ShellRun = {
      exitCode: null,
      signalName: '',
      stdout: { text: '', omittedChars: 0 },
      stderr: { text: '', omittedChars: 0 },
      timedOut: false,
      aborted: false,
      spawnError: ''
    }
    // 受限与不受限是两条 spawn:不受限那一支连一个字节都不该变(它的 `shell: SHELL` 语义、
    // 环境继承、cmd.exe 的行为都是既有单测钉住的),所以差别只写在这一份 spec 里。
    // 启动器进 argv 而不是拼进命令串:审批的放行键算的是命令本身,拼串会把那道判定一起改掉。
    const spec = launch
      ? {
          file: launch.file,
          args: [...launch.args, POSIX_SHELL, '-c', command],
          extra: { shell: false as const, env: launch.env }
        }
      : { file: command, args: [] as string[], extra: { shell: SHELL } }
    // stdin 一律 ignore:命令里只要有读输入的动作(cat 不带参数、read、要确认的 rm -i),
    // 管道会永远等不到内容,只能拖到超时才退
    const child = spawn(spec.file, spec.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      ...spec.extra
    })

    let graceTimer: NodeJS.Timeout | undefined
    const terminate = (reason: 'timedOut' | 'aborted'): void => {
      run[reason] = true
      killTree(child, 'SIGTERM')
      graceTimer = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS)
    }
    const timer = setTimeout(() => terminate('timedOut'), timeoutMs)
    const onAbort = (): void => terminate('aborted')
    signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (): void => {
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      signal?.removeEventListener('abort', onAbort)
      resolve(run)
    }

    // spawn 失败(如 cwd 不存在)只发 error、不会有 close,必须自己收尾
    child.on('error', (error) => {
      run.spawnError = describeFsError(error)
      finish()
    })
    child.on('close', (code, codeSignal) => {
      run.exitCode = code
      run.signalName = codeSignal ?? ''
      finish()
    })

    attachSink(child.stdout, run.stdout)
    attachSink(child.stderr, run.stderr)
  })
}

/** 秒数夹在 1~600:省略用默认值,给了非法值就拒绝而不是悄悄回落 */
function timeoutSecondsOf(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_TIMEOUT_SECONDS
  const seconds = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`timeout_seconds 要是正数秒数,收到的是 ${String(value)}`)
  }
  return Math.min(Math.max(seconds, 1), MAX_TIMEOUT_SECONDS)
}

function formatStream(label: string, sink: StreamSink): string {
  if (!sink.text) return `${label}: (无输出)`
  const mark = sink.omittedChars > 0 ? `[开头 ${sink.omittedChars} 字符已省略]\n` : ''
  return `${label}:\n${mark}${sink.text.replace(/\n$/, '')}`
}

export const runCommandTool: ToolDefinition = {
  name: 'run_command',
  description:
    '在本机执行一条 shell 命令,返回 exit_code、实际工作目录 cwd、stdout 与 stderr。' +
    'POSIX 下由 /bin/bash -c 执行,Windows 下由 cmd.exe 执行。' +
    '工作目录由 cwd 参数决定:可以是绝对路径、以 ~ 开头的路径,或相对本次会话工作空间的路径;' +
    '省略则为该工作空间(未设置工作空间时是应用当前目录)。' +
    '命令超过 timeout_seconds(默认 30 秒,最长 600 秒)或被中止时,进程连同它自己起的子进程一起被终止,' +
    '已产出的输出仍会返回。stdout 与 stderr 各保留末尾 16000 字符,更早的部分会标明已省略。' +
    '这条命令是否被关在受限执行环境里,取决于「沙箱」设置:在 macOS / Linux 上且那一档开着时,' +
    '命令由系统的受限执行机制包裹,它的文件写入出不了本次会话的工作空间与临时目录,' +
    '清单里点名的凭据目录也读不到;关掉、没选工作空间、或在 Windows 上时不受这道约束。' +
    '被这道边界拦下的读写会以非零退出码出现(常见是 Operation not permitted),那不是命令自身的故障。' +
    '它也不用来取用户的凭据与私密文件(私钥与 SSH 配置、authorized_keys、云厂商凭据、钥匙串、.env 与各类令牌文件);' +
    '需要输入内容的交互式命令不适用(stdin 已关闭)。' +
    '实际 cwd 落在工作空间之外时,结果末尾会附带一条说明。',
  // 不标 volatile:命令的结果常常是后续步骤要用的上下文(读到的清单、构建输出),
  // 每条都当过期会让多步任务反复重跑同一条命令。
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的完整命令行' },
      cwd: {
        type: 'string',
        description: '工作目录:绝对路径、~ 开头,或相对本次会话工作空间;省略则用该工作空间'
      },
      timeout_seconds: {
        type: 'number',
        description: `命令的超时秒数,默认 ${DEFAULT_TIMEOUT_SECONDS},最长 ${MAX_TIMEOUT_SECONDS}`
      }
    },
    required: ['command']
  },
  execute: async (args, context): Promise<string> => {
    const command = String(args.command ?? '').trim()
    if (!command) throw new Error('缺少 command')
    const workspace = context.workspace ?? ''
    const cwdArg = typeof args.cwd === 'string' ? args.cwd : ''
    const target = anchor(cwdArg, workspace)
    const cwd = target.path
    const timeoutSeconds = timeoutSecondsOf(args.timeout_seconds)
    if (context.signal?.aborted) throw new Error('本轮已被中止,命令没有执行')

    const exec = context.jail?.exec
    // 引擎装不上时**只拒这一条命令**,不退回不受限地跑:静默降级等于用户以为护栏还在,
    // 而这一句由注册表兜成 { ok:false },于是那次调用天然只落一条 tool 行。
    if (exec?.state === 'unavailable') {
      throw new Error(`受限执行在这台机器上装不上,命令没有执行:${exec.reason}`)
    }
    const launch = exec?.state === 'confined' ? exec.launch : undefined

    const run = await runShell(command, cwd, timeoutSeconds * 1000, context.signal, launch)
    if (run.spawnError) throw new Error(`命令无法启动(cwd=${cwd}):${run.spawnError}`)

    const exit =
      run.exitCode === null ? `无(进程被 ${run.signalName || '信号'}终止)` : String(run.exitCode)
    const lines: string[] = []
    if (run.timedOut) {
      lines.push(`命令超过 ${timeoutSeconds} 秒未结束,已被终止。以下是终止前已产出的内容。`)
    } else if (run.aborted) {
      lines.push('本轮被用户中止,命令已被终止。以下是中止前已产出的内容。')
    }
    lines.push(
      `exit_code: ${exit}`,
      `cwd: ${cwd}`,
      '',
      formatStream('stdout', run.stdout),
      '',
      formatStream('stderr', run.stderr)
    )
    if (exec?.state === 'confined') lines.push('', boundaryNote(exec, run))
    return annotate(lines.join('\n'), target, workspace)
  }
}

/**
 * 受限执行那一次的边界说明,两句各自管一件事:
 *
 * ① 「这次是关着跑的」—— 每个受限的调用都说一句,否则模型会把 EPERM 当成命令自己的故障,
 *    换个写法再试第三、第四遍;② 只在**非零退出且输出里出现边界特有的报错**时才追加,
 *    因为那种退出码既可能是边界也可能是命令自己坏了,一句话把两种可能都摆出来比断言一种准。
 *
 * 两句都是陈述句,不含祈使(与 `confine`、`describeAnswer` 同一条纪律)。
 */
function boundaryNote(exec: Extract<ExecBoundary, { state: 'confined' }>, run: ShellRun): string {
  const note =
    `[边界:本次命令在受限执行环境中运行——写入仅工作空间与临时目录,` +
    `清单内的凭据目录读不到,网络${exec.allowNetwork ? '放行' : '关闭'}]`
  const failed = run.exitCode !== null && run.exitCode !== 0
  const looksBlocked = BOUNDARY_FAILURES.test(`${run.stdout.text}\n${run.stderr.text}`)
  if (failed && looksBlocked) {
    return `${note}\n[注:上述非零退出可能来自这条边界,而不是命令自身的故障]`
  }
  return note
}
