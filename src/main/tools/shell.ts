import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { describeFsError, resolvePath } from './paths'
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

/** 杀进程:POSIX 下按进程组杀,命令里再起的孙子进程(sleep、管道下游)才不会被留下 */
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
  signal: AbortSignal | undefined
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
    // stdin 一律 ignore:命令里只要有读输入的动作(cat 不带参数、read、要确认的 rm -i),
    // 管道会永远等不到内容,只能拖到超时才退
    const child = spawn(command, {
      cwd,
      shell: SHELL,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true
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
    'POSIX 下由 /bin/bash -c 执行,Windows 下由 cmd.exe 执行。工作目录由 cwd 参数决定,省略则为应用当前目录。' +
    '命令超过 timeout_seconds(默认 30 秒,最长 600 秒)或被中止时,进程连同它自己起的子进程一起被终止,' +
    '已产出的输出仍会返回。stdout 与 stderr 各保留末尾 16000 字符,更早的部分会标明已省略。' +
    '命令在本机真实执行,没有沙箱;需要输入内容的交互式命令不适用(stdin 已关闭)。',
  // 不标 volatile:命令的结果常常是后续步骤要用的上下文(读到的清单、构建输出),
  // 每条都当过期会让多步任务反复重跑同一条命令。
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的完整命令行' },
      cwd: { type: 'string', description: '工作目录,绝对路径或 ~ 开头;省略则用应用当前目录' },
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
    const cwdArg = typeof args.cwd === 'string' ? args.cwd.trim() : ''
    const cwd = cwdArg ? resolvePath(cwdArg) : process.cwd()
    const timeoutSeconds = timeoutSecondsOf(args.timeout_seconds)
    if (context.signal?.aborted) throw new Error('本轮已被中止,命令没有执行')

    const run = await runShell(command, cwd, timeoutSeconds * 1000, context.signal)
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
    return lines.join('\n')
  }
}
