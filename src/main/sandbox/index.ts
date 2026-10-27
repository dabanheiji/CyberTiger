import fs from 'fs'
import os from 'os'
import path from 'path'
import { describeFsError } from '../tools/paths'
import { resolveDeep } from '../tools/jail'
import { bwrapArgv, canonicalPrivatePaths, seatbeltProfile } from './policy'
import type { DeniedPath } from './policy'
import { minimalEnv } from './env'
import type { EngineProbeResult } from './preflight'
import type { SandboxEngine, SandboxSettings } from '../store/types'

/**
 * 一次 run 的文件写入 jail:根目录**一定是 realpath 过的**,判定层因此不再兜根那一侧。
 *
 * 为什么单独一个叶子目录:调用点在 `chat/service.ts` 的 `startRun`,而它已经牵着
 * DB 与 electron-store;这一层只吃两份纯值(设置里那一键 + 会话的工作空间),
 * 「jail 开不开」这条规则就能脱离应用被单测钉住。反过来从 `main/index.ts` 导会成环,
 * 理由与 `appearance.ts` 同一条。目录里其余三档(`policy` / `env` / `preflight`)服务的是
 * 受限执行那一半,同样只往内依赖,不认识 electron、DB 与窗口。
 *
 * 为什么缺省是**开**:与 `permissions` 缺键即 `'ask'` 同一条纪律 —— 老用户的配置文件里
 * 没有这一键,而 jail 正是更严的那一侧。
 */
export function jailFor(
  sandbox: SandboxSettings | undefined,
  workspace: string
): { root: string } | undefined {
  if (sandbox?.enabled === false) return undefined
  const dir = workspace.trim()
  // 没选工作空间就无处可 jail:那一支仍走「越界写入一律审批」的老路
  if (!dir) return undefined
  try {
    fs.mkdirSync(dir, { recursive: true })
    return { root: fs.realpathSync(dir) }
  } catch (error) {
    // fail-closed:建不出来就整轮不开始,而不是静默退回"没有边界"继续跑
    throw new Error(`工作空间目录 ${dir} 已不可用:${describeFsError(error)},写入未执行`)
  }
}

/** 边界没装上的三种原因,界面上要分开说 —— 它们给出的下一步动作完全不同 */
export type ExecOffReason =
  /** 用户显式关掉了沙箱或 `exec` 这一颗 */
  | 'disabled'
  /** 这一条会话没选工作空间,因而没有根 */
  | 'no-workspace'
  /** 这台机器没有 OS 级的机制(Windows) */
  | 'platform'

/** 受限执行那一支的启动方式:argv 里只有启动器与旗标,**命令本身不在这里** */
export interface ExecLaunch {
  file: string
  args: string[]
  env: Record<string, string>
}

/**
 * 一次 run 的 shell 执行边界。
 *
 * 三个状态而不是布尔:`off` 是「不该问为什么」(用户关的 / 没根 / 这台机器没有),
 * `unavailable` 是「该有但装不上」(引擎缺 / 内核不让 / 规则编译不过),
 * `confined` 才是真边界。把 `unavailable` 混进 `off` 就会静默退回不受限地跑 ——
 * 那正是这一期要避免的唯一一种错法。
 */
export type ExecBoundary =
  | { state: 'off'; reason: ExecOffReason }
  | { state: 'unavailable'; reason: string }
  | {
      state: 'confined'
      engine: SandboxEngine
      launch: ExecLaunch
      /**
       * 常驻作业用的启动器;缺省即与 `launch` 相同。
       * 只有 bwrap 这一支需要两份(build 时旗标不同),seatbelt 的 `sandbox-exec` 是 exec,
       * 前台与常驻本来就是同一条。
       */
      persistLaunch?: ExecLaunch
      allowNetwork: boolean
    }

/**
 * 清单里**磁盘上真有**的那几条,逐条解过真身。
 *
 * 不存在的条目必须跳过:`resolveDeep` 对还不存在的路径会退到最近的已存在祖先,于是没装 gh 的机器上
 * `~/.config/gh` 解成 `~/.config`、`~/.gnupg` 解成 `~` —— 那等于把整条主目录点名读不到。
 * 这种配置还会与「允许写 home」撞出清单冲突,后果是这台机器上再也没有 shell 命令能跑。
 * 代价是这一轮中途才出现的凭据目录拦不住,而那份代价比「把 home 遮了」小得多。
 */
function existingPrivatePaths(home: string): DeniedPath[] {
  return canonicalPrivatePaths(home, process.platform)
    .filter((entry) => fs.existsSync(entry.path))
    .map((entry) => ({ path: resolveDeep(entry.path), directory: entry.directory }))
}

/**
 * 把设置、jail 根与探针结论合成一份 run 快照。
 *
 * **同步**:探针由调用方 `await engineProbe()` 之后再传进来(结论在进程内 memo),于是每次发消息
 * 都不起 spawn。构建顺序必须是 `minimalEnv` 先于 `bwrapArgv` —— 那边要拿同一份 PATH 去 `--setenv`,
 * 两边各算一次就会出现「沙箱里的 PATH 与 profile 里给的不是一份」。
 *
 * 路径一律走 `tools/jail.ts` 的 `resolveDeep`,这里不新增第二处 `fs.realpathSync`:
 * `(deny file-write* (subpath "/tmp"))` 这类**静默永不命中**的规则实测就是这么来的
 * (内核匹配的是解出来的 `/private/tmp`)。
 */
export function execFor(
  sandbox: SandboxSettings | undefined,
  jail: { root: string } | undefined,
  probe: EngineProbeResult
): ExecBoundary {
  if (sandbox?.enabled === false || sandbox?.exec === false)
    return { state: 'off', reason: 'disabled' }
  if (!jail) return { state: 'off', reason: 'no-workspace' }
  // 探针说没有这种机制:那是「这台机器上 shell 一直不受约束」,不是故障
  if (probe.engine === 'none') return { state: 'off', reason: 'platform' }
  // 引擎装不上就只拒 `run_command`(见 shell 那一侧的拒绝句),绝不退回不受限地跑
  if (!probe.available) return { state: 'unavailable', reason: probe.reason ?? '预检没有给出原因' }

  // 网络缺键即**放行**:这一颗的方向与安全无关,是「装包 / 拉代码 / curl 还能不能用」的产品取舍,
  // 所以它是对「缺省即最保守」那条纪律的一次公开例外,由设置页与文档各自写明代价。
  const allowNetwork = sandbox?.network !== false
  const home = resolveDeep(os.homedir())
  const tmpdir = resolveDeep(os.tmpdir())
  const env = minimalEnv(process.env, home, tmpdir)
  const input = {
    workspace: jail.root,
    tmpdir,
    home,
    writableExtra: [],
    allowNetwork,
    deniedRead: existingPrivatePaths(home)
  }
  try {
    if (probe.engine === 'seatbelt') {
      // sandbox-exec 是 `exec`,不 fork、不换进程组:前台与常驻用的是同一条启动方式
      const launch = {
        file: '/usr/bin/sandbox-exec',
        args: ['-p', seatbeltProfile(input)],
        env
      }
      return {
        state: 'confined',
        engine: probe.engine,
        allowNetwork,
        launch,
        persistLaunch: launch
      }
    }
    // 掩蔽用的空目录:被点名的目录盖它,于是命令看到「存在但列不出内容」。
    // 预创建的姿态与 jailFor 的根一致 —— 它落在 tmpdir 之下,那道允许两条边都看得见。
    const maskDir = path.join(tmpdir, 'cybertiger-mask')
    fs.mkdirSync(maskDir, { recursive: true })
    return {
      state: 'confined',
      engine: probe.engine,
      allowNetwork,
      launch: { file: 'bwrap', args: bwrapArgv(input, maskDir, env.PATH), env },
      // 常驻那一份只是少了两个与「进程组 / 父进程死亡」有关的旗标,见 bwrapArgv
      persistLaunch: {
        file: 'bwrap',
        args: bwrapArgv(input, maskDir, env.PATH, { persist: true }),
        env
      }
    }
  } catch (error) {
    // 清单冲突(把工作空间选成了 `~`,或选成了 `~/.ssh` 底下这类)是配置问题,不是引擎故障:
    // 拒掉命令并把原因说清楚,文件 jail 那道边界仍然装着
    return { state: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
  }
}
