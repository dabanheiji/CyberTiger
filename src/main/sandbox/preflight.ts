import { execFile } from 'node:child_process'
import os from 'node:os'
import { resolveDeep } from '../tools/jail'
import { canonicalPrivatePaths, seatbeltProfile, type ExecPolicyInput } from './policy'
import type { SandboxEngine, SandboxExecStatus } from '../store/types'

/**
 * 引擎预检:这一台机器上到底跑不跑得起受限执行。
 *
 * 为什么要预检而不是直接 spawn:引擎起不来有三种形态,结论完全不同 ——
 * ① 这台机器没有这种机制(Windows),② 有机制但缺东西(Linux 没装 bwrap,或内核不让非特权用户
 * 建命名空间),③ 有机制而规则本身编译不过(mac)。三者要分开说,因为「②和③只能拒
 * `run_command`,而①本来就没有边界」是两句不同的实话;写成一句就有一条是假的。
 *
 * 探针**不刷新**:一次进程内只跑一次并记住结论(约 100–500ms 的 spawn 不进发消息的关键路径)。
 * 代价是「会话中途装了 bwrap 要重启应用才认」,这一句写在设置页的状态条里。
 */

/** 一次探针的原始事实,交给 `interpretProbe` 赋意义 —— 分开是因为后者要能脱离进程测 */
export interface ProbeOutcome {
  /** 退出码;被信号杀掉或压根没起进程时是 null */
  code: number | null
  /** 死在进程之外的原因:`ENOENT` = 引擎不在,`timeout` = 探针超时,其它 = spawn 的原始错误 */
  failure?: string
  signal?: string
  stderr: string
}

export type EngineProbeResult = Omit<SandboxExecStatus, 'platform'>

/** 探针的超时。预检在启动后预热,但 `startRun` 那一路也要 await,所以不能没有上限 */
const PROBE_TIMEOUT_MS = 2000

export function engineFor(platform: NodeJS.Platform): SandboxEngine {
  if (platform === 'darwin') return 'seatbelt'
  if (platform === 'linux') return 'bwrap'
  return 'none'
}

/**
 * mac 探针用的输入:拿临时目录当根。
 *
 * 跑的是**生产那台生成器**产出的 profile,所以这一支顺带是 `policy.ts` 的编译检查 ——
 * 实测 profile 编译不过时 `sandbox-exec` 退出 65 且载荷根本不会被执行,于是「这里生成的规则
 * 写错了」和「系统的引擎变了」虽然都落在不可用上,理由句能把两者分开讲。
 */
function seatbeltProbeInput(tmpdir: string): ExecPolicyInput {
  // 假 home 用一个不可能存在的目录:探针只需要文本合法,而它若落在 tmpdir 之下,
  // 清单冲突那条检查会先拒掉——那是给真配置用的约束,不该在这里挡路
  const home = '/private/tmp/cybertiger-probe-home'
  return {
    workspace: tmpdir,
    tmpdir,
    home,
    writableExtra: [],
    allowNetwork: true,
    deniedRead: canonicalPrivatePaths(home, 'darwin')
  }
}

/** Linux 探针验的是「能不能建立命名空间」,不带挂载之外的规则 */
function bwrapProbeArgv(): string[] {
  return [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--setenv',
    'PATH',
    '/usr/bin',
    '--',
    '/usr/bin/true'
  ]
}

/**
 * 把一次探针的原始结果翻译成「这台机器用不用得上」。
 *
 * 纯函数,所以三种引擎、五种死法都能脱离进程验一遍。判错的代价是界面说「可用」而命令实际
 * 起不来(或反过来白拦一整条路),那种不一致只有断言拦得住。
 */
export function interpretProbe(engine: SandboxEngine, outcome: ProbeOutcome): EngineProbeResult {
  if (engine === 'none') {
    return {
      engine,
      available: true,
      reason: '这台机器上没有 OS 级的受限执行机制,shell 命令一直不受边界约束。'
    }
  }
  if (outcome.failure === 'ENOENT') {
    return {
      engine,
      available: false,
      reason:
        engine === 'seatbelt'
          ? '系统里的 /usr/bin/sandbox-exec 不在,受限执行建立不起来。'
          : '本机没有 bubblewrap(bwrap),受限执行建立不起来;这个包在 debian 系叫 bubblewrap,装好并重启应用后这一栏会自己跟上。'
    }
  }
  if (outcome.failure === 'timeout') {
    return {
      engine,
      available: false,
      reason: `受限执行的探针在 ${PROBE_TIMEOUT_MS} 毫秒内没有返回,这道边界是否装得上无从确认。${lead(outcome)}`
    }
  }
  if (outcome.failure) {
    return {
      engine,
      available: false,
      reason: `受限执行的探针没能启动(${outcome.failure}),这道边界装不上。${lead(outcome)}`
    }
  }
  if (outcome.code === 0) return { engine, available: true }
  if (engine === 'seatbelt' && outcome.code === 65) {
    return {
      engine,
      available: false,
      reason:
        'sandbox-exec 没能编译这份边界规则(退出码 65)。可能是系统自带的引擎变了,也可能是这里生成的规则写错了;' +
        `两种情况下命令都不会被执行,而不是退回不受限地跑。${lead(outcome)}`
    }
  }
  if (engine === 'bwrap') {
    return {
      engine,
      available: false,
      reason:
        `bwrap 装载后探针没能正常退出(${death(outcome)})。` +
        '常见原因是内核不允许非特权用户建立命名空间(Ubuntu 24.04 起有 AppArmor 这一层限制),' +
        `这里不会改走 setuid bwrap 那条退路。${lead(outcome)}`
    }
  }
  return {
    engine,
    available: false,
    reason: `受限执行的探针没能正常退出(${death(outcome)})。${lead(outcome)}`
  }
}

function death(outcome: ProbeOutcome): string {
  return outcome.code === null ? `被 ${outcome.signal ?? '信号'} 杀掉` : `退出码 ${outcome.code}`
}

/**
 * 引擎给的第一行:一句 `sandbox-exec: syntax error: …` 或 `bwrap: setting up uid map: …`
 * 就是这一句里唯一说明「为什么」的部分。取第一行而不是最后一行,因为后者在 mac 上是
 * backtrace 的坐标 —— 那对看不懂 profile 的人没有信息量。太长就截断,一次探针可能吐一整页。
 */
function lead(outcome: ProbeOutcome): string {
  const line =
    outcome.stderr
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? ''
  if (!line) return ''
  return `引擎给的第一条说明:${line.slice(0, 200)}`
}

function run(file: string, args: string[]): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' },
      (error, _stdout, stderr) => {
        const failure = error as
          (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null
        const out = String(stderr ?? '')
        if (!failure) resolve({ code: 0, stderr: out })
        else if (failure.code === 'ENOENT') resolve({ code: null, failure: 'ENOENT', stderr: out })
        else if (failure.killed)
          resolve({ code: null, failure: 'timeout', signal: failure.signal, stderr: out })
        else if (failure.signal) resolve({ code: null, signal: failure.signal, stderr: out })
        else
          resolve({
            code: typeof failure.code === 'number' ? failure.code : null,
            failure: typeof failure.code === 'string' ? failure.code : undefined,
            stderr: out
          })
      }
    )
  })
}

let memo: Promise<EngineProbeResult> | null = null

/**
 * 引擎结论的缓存。**只缓存结论,不缓存 promise** —— 探针是 await 的,而 `startRun` 与设置页
 * 几乎同时调它:存 promise 会让那 100–500ms 里两边各自起一份探针,更要紧的是任何一次 reject
 * (realpath 抛错之类)会被永久记住,之后每一轮都拿到同一个失败结论。
 * 不并行去重是刻意的:探针只在启动预热与进设置页时跑,同一个 tick 里撞上的代价是多跑一次 spawn。
 */
export async function engineProbe(): Promise<EngineProbeResult> {
  if (memo) return memo
  const result = await probe().catch((error: unknown): EngineProbeResult => ({
    engine: engineFor(process.platform),
    available: false,
    reason: `受限执行的预检自身出错:${error instanceof Error ? error.message : String(error)}`
  }))
  memo = Promise.resolve(result)
  return result
}

async function probe(): Promise<EngineProbeResult> {
  const engine = engineFor(process.platform)
  if (engine === 'none') return interpretProbe(engine, { code: 0, stderr: '' })
  if (engine === 'seatbelt') {
    const profile = seatbeltProfile(seatbeltProbeInput(resolveDeep(os.tmpdir())))
    return interpretProbe(
      engine,
      await run('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/true'])
    )
  }
  const version = await run('bwrap', ['--version'])
  if (version.failure === 'ENOENT') return interpretProbe(engine, version)
  return interpretProbe(engine, await run('bwrap', bwrapProbeArgv()))
}
