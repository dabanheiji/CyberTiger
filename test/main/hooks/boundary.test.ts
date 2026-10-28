import type { ExecBoundary, ExecLaunch } from '../../../src/main/sandbox/index'
import type { SandboxSettings } from '../../../src/main/store/types'
import type { HookBoundary, RunHook, SkipHook } from '../../../src/main/hooks/boundary'
import { boundaryOf } from '../../../src/main/hooks/boundary'
import { resolveHookCommand } from '../../../src/main/hooks/contract'
import type { HookMeta } from '../../../src/main/hooks/types'

/**
 * `sandboxed` 那张对接表是钩子唯一的「跑在哪一侧」真值,而它每一行都对应一种坏法:
 * 少一行就是「静默放宽」或「凭空不跑」。所以七行逐条断言,三条方向性的还要断它给出的对象。
 */

const DIR = '/Users/x/Library/Application Support/cybertiger/hooks/notify'

function hook(sandboxed: boolean, command = '/usr/bin/osascript'): HookMeta {
  return {
    name: 'notify',
    description: '回答结束后发一条系统通知',
    event: 'afterAgent',
    command,
    args: [],
    matcher: [],
    sandboxed,
    timeoutMs: 10_000,
    once: false,
    doc: '',
    dir: DIR,
    enabled: true
  }
}

const LAUNCH: ExecLaunch = {
  file: '/usr/bin/sandbox-exec',
  args: ['-p', '(version 1)'],
  env: { PATH: '/bin' }
}

function jail(exec?: ExecBoundary): { root: string; exec?: ExecBoundary } {
  return { root: '/Users/x/ws', exec }
}

const CONFINED: ExecBoundary = {
  state: 'confined',
  engine: 'seatbelt',
  launch: LAUNCH,
  allowNetwork: true
}
const UNAVAILABLE: ExecBoundary = { state: 'unavailable', reason: '这台机器上没有 sandbox-exec' }
const OFF = (reason: 'disabled' | 'no-workspace' | 'platform'): ExecBoundary => ({
  state: 'off',
  reason
})

/** 「这一支该跑」是这些用例的前提;不成立就把跳过的那句理由原样抛出来,而不是报一堆 undefined */
function mustRun(out: HookBoundary): RunHook {
  if (out.mode !== 'run') throw new Error(`本该跑,结论却是跳过:${out.why}`)
  return out
}

function mustSkip(out: HookBoundary): SkipHook {
  if (out.mode !== 'skip') throw new Error(`本该跳过,结论却是 ${out.mode}:${out.why}`)
  return out
}

describe('boundaryOf:sandboxed 是默认档时,边界那几种情形与它无关', () => {
  it('没开 sandboxed 的钩子永远不被关进启动器:即使这次快照就是一份 confined', () => {
    const out = mustRun(boundaryOf(hook(false), jail(CONFINED), { enabled: true }, '/Users/x/ws'))
    // 这一条是「默认按全权限跑」的全部含义:拿到 launch 就等于悄悄把没被要求的钩子关进边界
    expect(out.launch).toBeUndefined()
    expect(out.boundary).toBe('unrestricted')
  })

  it('引擎装不上时,默认那档照跑:坏的是那道边界,不是这条钩子', () => {
    const out = mustRun(
      boundaryOf(hook(false), jail(UNAVAILABLE), { enabled: true }, '/Users/x/ws')
    )
    expect(out.boundary).toBe('unrestricted')
  })

  it('沙箱被整个关掉时也是「未受限(默认)」那句话:不写「已被你关掉」,因为这条钩子本来就不受它约束', () => {
    expect(boundaryOf(hook(false), undefined, { enabled: false }, '')).toMatchObject({
      mode: 'run',
      launch: undefined,
      boundary: 'none',
      why: '未受限(默认)'
    })
  })

  it('没选工作空间时 boundary 写成 none:钩子脚本要分得清「有边界但我不在里面」和「根本没有边界」', () => {
    expect(mustRun(boundaryOf(hook(false), undefined, undefined, '')).boundary).toBe('none')
    expect(
      mustRun(boundaryOf(hook(false), jail(OFF('disabled')), { enabled: true }, '')).boundary
    ).toBe('unrestricted')
  })
})

describe('boundaryOf:sandboxed 声明后的那七行', () => {
  it('沙箱那颗被用户关掉 → 跑,不受限,并把「是他关的」写进日志', () => {
    expect(boundaryOf(hook(true), undefined, { enabled: false }, '/Users/x/ws')).toEqual({
      mode: 'run',
      launch: undefined,
      boundary: 'none',
      why: '未受限(沙箱已被你关掉)'
    })
  })

  it('没选工作空间 → 跳过,且理由写明「不会退回不受限地运行」:这一支是方向性的', () => {
    const out = mustSkip(boundaryOf(hook(true), undefined, { enabled: true }, ''))
    expect(out.why).toContain('没有选工作空间')
    expect(out.why).toContain('不会退回不受限地运行')
    // 跳过的一侧在类型上就不可能带 launch:少了这条,下一次改动可能「顺手」补一个不受限的跑法
    expect('launch' in out).toBe(false)
  })

  it('有工作空间却没有边界(根建不出来的那一种)也只能跳过:理由里要看得见是哪个目录', () => {
    expect(
      mustSkip(boundaryOf(hook(true), undefined, { enabled: true }, '/Users/x/gone')).why
    ).toContain('/Users/x/gone')
  })

  it('沙箱开着但快照里没有 exec 那一档 → 跑并说清是「少一档」,不与「用户关掉了」混成一句', () => {
    const out = mustRun(boundaryOf(hook(true), jail(undefined), { enabled: true }, '/Users/x/ws'))
    expect(out.boundary).toBe('unrestricted')
    expect(out.why).toContain('这次快照里没有受限执行那一档')
  })

  it('confined → 用与 run_command 同一个启动器对象(toBe,不是同值):同一份 profile、同一份白名单', () => {
    const out = mustRun(boundaryOf(hook(true), jail(CONFINED), { enabled: true }, '/Users/x/ws'))
    expect(out).toEqual({ mode: 'run', launch: LAUNCH, boundary: 'confined', why: '受限' })
    expect(out.launch).toBe(LAUNCH)
  })

  it('unavailable → 跳过,理由带上引擎给的那一句;这里绝不给出 launch', () => {
    const out = mustSkip(
      boundaryOf(hook(true), jail(UNAVAILABLE), { enabled: true }, '/Users/x/ws')
    )
    expect(out.why).toContain('不可用')
    expect(out.why).toContain('这台机器上没有 sandbox-exec')
    expect('launch' in out).toBe(false)
  })

  it('off 的三种 reason 各写各的一句话:设置页那三颗开关是独立的,读日志的人要能认出是哪一颗', () => {
    const disabled = mustRun(
      boundaryOf(hook(true), jail(OFF('disabled')), { enabled: true }, '/Users/x/ws')
    )
    const platform = mustRun(
      boundaryOf(hook(true), jail(OFF('platform')), { enabled: true }, '/Users/x/ws')
    )
    expect(disabled.why).toContain('关进受限执行环境')
    expect(disabled.why).toContain('那一颗关着')
    expect(platform.why).toContain('这台机器没有对应的机制')
    expect(disabled.why).not.toBe(platform.why)
    expect(disabled.boundary).toBe('unrestricted')
  })

  it('三种「跑」的 boundary 与「为什么跑」要一起说清:界面只读这两格,读不出第三种就是文档在说谎', () => {
    const settings: SandboxSettings = { enabled: true }
    const labels = [
      boundaryOf(hook(true), jail(CONFINED), settings, '/Users/x/ws'),
      boundaryOf(hook(true), jail(OFF('platform')), settings, '/Users/x/ws'),
      boundaryOf(hook(true), undefined, { enabled: false }, '/Users/x/ws')
    ].map((one) => (one.mode === 'run' ? `${one.boundary}|${one.why}` : 'skip'))
    expect(labels).toEqual([
      'confined|受限',
      'unrestricted|未受限(这台机器没有对应的机制)',
      'none|未受限(沙箱已被你关掉)'
    ])
  })
})

describe('boundaryOf:cwd 不进这张表', () => {
  it('六种分支的结论里都没有 cwd 这一格,而进程的工作目录恒为钩子目录', () => {
    const settings: SandboxSettings = { enabled: true }
    const branches = [
      boundaryOf(hook(true), jail(CONFINED), settings, '/Users/x/ws'),
      boundaryOf(hook(true), jail(OFF('disabled')), settings, '/Users/x/ws'),
      boundaryOf(hook(true), jail(UNAVAILABLE), settings, '/Users/x/ws'),
      boundaryOf(hook(true), undefined, { enabled: false }, '/Users/x/ws'),
      boundaryOf(hook(true), undefined, settings, ''),
      boundaryOf(hook(false), jail(CONFINED), settings, '/Users/x/ws')
    ]
    // 结论里没有 cwd:分支表只管「有没有被关进去」,免得读者以为「沙箱会换个目录跑」
    for (const one of branches) expect(Object.keys(one)).not.toContain('cwd')
    for (const sandboxed of [true, false]) {
      expect(resolveHookCommand(hook(sandboxed)).cwd).toBe(DIR)
      expect(resolveHookCommand(hook(sandboxed, './hook.mjs')).cwd).toBe(DIR)
    }
  })
})
