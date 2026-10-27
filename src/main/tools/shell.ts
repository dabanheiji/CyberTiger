import { annotate, anchor } from './paths'
import { runProcess } from '../process/spawn'
import type { OutputBill, ProcOutcome } from '../process/types'
import type { ExecBoundary } from '../sandbox'
import type { ToolDefinition } from './types'

const DEFAULT_TIMEOUT_SECONDS = 60
const MAX_TIMEOUT_SECONDS = 600

/**
 * 边界造成的失败长什么样。
 *
 * 只匹配这几句:内核给的 EPERM/EROFS 与命令自己的故障在退出码上分不出来,而模型读到
 * 「No such file or directory」这类太常见的报错会跟着往错误的方向找原因,所以那句不进匹配。
 *
 * `Permission denied` 同样不进:它在正常开发里太常见(读一个没有权限的文件、写 root 拥有的目录),
 * 而 mac 的沙箱拦下来的是 `Operation not permitted` —— 留着它等于把一大半普通失败
 * 都贴上「可能是边界」的标签,那句话就没人信了。
 */
const BOUNDARY_FAILURES =
  /Operation not permitted|Read-only file system|Network is unreachable|Temporary failure in name resolution/

/** 秒数夹在 1~600:省略用默认值,给了非法值就拒绝而不是悄悄回落 */
function timeoutSecondsOf(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_TIMEOUT_SECONDS
  const seconds = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`timeout_seconds 要是正数秒数,收到的是 ${String(value)}`)
  }
  return Math.min(Math.max(seconds, 1), MAX_TIMEOUT_SECONDS)
}

function formatOutput(output: OutputBill): string {
  const { head, tail, chars, lines, dropped } = output
  if (chars === 0) return '输出: (无输出)'
  const summary = `输出: 共 ${lines} 行 / ${chars} 字符`
  const body =
    dropped > 0
      ? `${head}${head.endsWith('\n') ? '' : '\n'}[… 中间 ${dropped} 字符已省略 …]\n${tail}`
      : `${head}${tail}`
  return `${summary}\n\n---\n${body.replace(/\n$/, '')}`
}

function exitLine(run: ProcOutcome): string {
  if (run.code !== null) return String(run.code)
  // kind 是 exited 却有信号,只可能是别人杀的:我们自己在超时 / 中止时才发信号
  const external = run.kind === 'exited' ? ',本次调用没有发出停止指令' : ''
  return `无(进程被 ${run.signal || '信号'}终止${external})`
}

export const runCommandTool: ToolDefinition = {
  name: 'run_command',
  description:
    '在本机执行一条 shell 命令(前台执行,一次调用对应一件事),返回 exit_code、实际工作目录 cwd、耗时与输出。' +
    'POSIX 下由 /bin/bash -c 执行,Windows 下由 cmd.exe 执行。' +
    '工作目录由 cwd 参数决定:可以是绝对路径、以 ~ 开头的路径,或相对本次会话工作空间的路径;' +
    '省略则为该工作空间(未设置工作空间时是应用当前目录)。' +
    '命令超过 timeout_seconds(默认 60 秒,最长 600 秒)或被中止时,进程连同它自己起的子进程一起被终止,' +
    '已产出的输出仍会返回。' +
    '这条调用结束时,命令留在后台的子进程也会被一并终止 —— 常驻服务不能靠一条普通命令留住,' +
    '它在调用返回后不会继续运行;需要常驻的进程由 background_job 工具启动,它不受这条调用结束的影响。' +
    'stdout 与 stderr 合并成一条输出、按发生顺序排列,stderr 的每一行带 [stderr] 前缀;' +
    '输出最多保留 16000 字符(开头与结尾各留一部分,中间被省掉的部分会标明字符数)。' +
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

    const run = await runProcess({
      command,
      cwd,
      launch,
      timeoutMs: timeoutSeconds * 1000,
      signal: context.signal
    })
    if (run.spawnError) throw new Error(`命令无法启动(cwd=${cwd}):${run.spawnError}`)

    const lines: string[] = []
    if (run.kind === 'timeout') {
      lines.push(`命令超过 ${timeoutSeconds} 秒未结束,已被终止。以下是终止前已产出的内容。`)
    } else if (run.kind === 'aborted') {
      lines.push('本轮被用户中止,命令已被终止。以下是中止前已产出的内容。')
    }
    lines.push(
      `exit_code: ${exitLine(run)}`,
      `cwd: ${cwd}`,
      `耗时: ${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s`,
      formatOutput(run.output)
    )
    // 前台调用退出即清场:说清是我杀的,否则模型会把「服务没起来」归到它自己的命令上
    if (run.kind === 'exited' && run.drained) {
      lines.push('[注:命令退出后仍有子进程占用它的输出管道,这些进程已被一并终止]')
    }
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
function boundaryNote(
  exec: Extract<ExecBoundary, { state: 'confined' }>,
  run: ProcOutcome
): string {
  const note =
    `[边界:本次命令在受限执行环境中运行——写入仅工作空间与临时目录,` +
    `清单内的凭据目录读不到,网络${exec.allowNetwork ? '放行' : '关闭'}]`
  const failed = run.code !== null && run.code !== 0
  const looksBlocked = BOUNDARY_FAILURES.test(`${run.output.head}${run.output.tail}`)
  if (failed && looksBlocked) {
    return `${note}\n[注:上述非零退出可能来自这条边界,而不是命令自身的故障]`
  }
  return note
}
