import type { ExecBoundary, ExecLaunch } from '../sandbox/index'
import type { SandboxSettings } from '../store/types'
import type { HookBoundaryLabel } from './contract'
import type { HookMeta } from './types'

/**
 * `sandboxed` 与既有那道边界的对接表。
 *
 * 一条规则:**钩子拿到的是与 `run_command` 同一份快照里的同一个对象**。这一层不重算边界、
 * 不做任何 IO(探针结论早在这次 run 开始前就 memo 过了),只把那张表翻译成三种结论。
 *
 * `jailFor` 把「沙箱已被你关掉」与「这条会话没选工作空间」压成同一个 `undefined`,
 * 所以这里必须同时收 `sandbox` 与 `workspace` 才分得开那两种 —— 也正是这个 helper
 * 单列为纯函数(而不是在 runner 里内联一个 `if`)的理由:那七行都能脱离应用断言。
 *
 * cwd **不进这张表**:六种分支的进程工作目录都是钩子自己的目录(见 contract.ts 的
 * `resolveHookCommand`),免得读者以为「沙箱会换目录」。
 */

/** 跑:要么按用户全权限,要么被关进 `launch` 里 */
export interface RunHook {
  mode: 'run'
  /** undefined 即不受限地跑(继承 `process.env`);有值即用与 `run_command` 同一个启动器包住 */
  launch: ExecLaunch | undefined
  /** 写进 payload 的 `boundary` 与日志的那一档 */
  boundary: HookBoundaryLabel
  /** 一句实话:不受限时是「为什么不受限」,受限时是「受限」 */
  why: string
}

/** 跳过:边界建不出来。这里**没有**「退回不受限地跑」那一支 —— 那是方向性原则 */
export interface SkipHook {
  mode: 'skip'
  /** 给用户在「最近执行」那一行看到的那句理由 */
  why: string
}

export type HookBoundary = RunHook | SkipHook

/** 这次会话到底有没有边界;`confined` 之外的一档要说清「有边界但这条钩子不在里面」还是「根本没有边界」 */
function sessionBoundary(jail: ExecBoundaryShape | undefined): HookBoundaryLabel {
  return jail === undefined ? 'none' : 'unrestricted'
}

type ExecBoundaryShape = { root: string; exec?: ExecBoundary } | undefined

/**
 * 这一次钩子该怎么跑。
 *
 * | `sandboxed` | 边界 | 结果 |
 * |---|---|---|
 * | false(默认) | 任意 | 按全权限跑,继承 `process.env` |
 * | true | 沙箱那颗被关 | 跑,不受限,日志写明「已被你关掉」 |
 * | true | 没选工作空间 | **跳过**,不退回不受限地跑 |
 * | true | `confined` | 用同一个 `launch` 包住跑 |
 * | true | `unavailable` | **跳过**,理由 = 引擎给的那句 |
 * | true | `off`(exec 那颗关了 / 这台机器没机制) | 跑,不受限,日志写明是哪一种 |
 */
export function boundaryOf(
  hook: HookMeta,
  jail: ExecBoundaryShape,
  sandbox: SandboxSettings | undefined,
  workspace: string
): HookBoundary {
  if (!hook.sandboxed) {
    // 默认那一支:沙箱开着还是关着都与此无关 —— 钩子是按用户全权限跑的用户自己的程序。
    // 这一条是「设置页第 1、3 点」成立的前提,别让任何开关顺手把它改了
    return { mode: 'run', launch: undefined, boundary: sessionBoundary(jail), why: '未受限(默认)' }
  }

  if (jail === undefined) {
    if (sandbox?.enabled === false) {
      // 用户显式关掉了写入边界:这一次「不受限」是他的指示,不是这一层的失败
      return { mode: 'run', launch: undefined, boundary: 'none', why: '未受限(沙箱已被你关掉)' }
    }
    if (workspace.trim() === '') {
      // 没有工作空间就没有根,也就没有「边界」这个东西。跳过而不是放行:
      // 声明了 sandboxed 的钩子想要的是「别让它写到外面去」,不受限地跑一遍恰好相反
      return { mode: 'skip', why: '这条会话没有选工作空间,因而建不出边界;不会退回不受限地运行它' }
    }
    // 有工作空间却没有 jail 只剩一种可能:根不存在又建不出来 —— 那种情况 startRun 已经让整轮
    // 以 error 收场,走不到这里。这一支留着是为了「宁可不跑,也不不受限地跑」在类型上无缺口
    return { mode: 'skip', why: `工作空间 ${workspace} 上没有可用的边界,不会退回不受限地运行它` }
  }

  const exec = jail.exec
  if (exec === undefined) {
    // 有写入边界但没有执行边界那一档(生产里 jailFor 会给,这是接线遗漏时的形状):
    // 与「沙箱被关掉」区别开,因为那三颗开关是独立的,读日志的人要能认出是哪一颗
    return {
      mode: 'run',
      launch: undefined,
      boundary: 'unrestricted',
      why: '未受限(这次快照里没有受限执行那一档)'
    }
  }
  if (exec.state === 'confined') {
    // 与 run_command 同一个对象:同一份 profile、同一份白名单环境、同一批点名读不到的目录
    return { mode: 'run', launch: exec.launch, boundary: 'confined', why: '受限' }
  }
  if (exec.state === 'unavailable') {
    // 引擎装不上 / 预检不过:与 shell.ts 拒那次调用同一方向,绝不静默放宽
    return { mode: 'skip', why: `受限执行在这台机器上不可用:${exec.reason}` }
  }
  const why =
    exec.reason === 'disabled'
      ? '未受限(「把命令关进受限执行环境」那一颗关着)'
      : exec.reason === 'platform'
        ? '未受限(这台机器没有对应的机制)'
        : '未受限(这条会话没有选工作空间)'
  // `no-workspace` 那一支在这里到不了:没有工作空间就没有 jail。写出来只为让 reason 三种都有说法
  return { mode: 'run', launch: undefined, boundary: 'unrestricted', why }
}
