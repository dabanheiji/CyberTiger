import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFor, jailFor } from '../../src/main/sandbox'
import type { ExecBoundary } from '../../src/main/sandbox'
import { resolveDeep } from '../../src/main/tools/jail'
import type { EngineProbeResult } from '../../src/main/sandbox/preflight'
import { makeTempDir, removeTempDir, writeFiles } from '../helpers/temp'

/**
 * 「边界装不装」这条规则,两份:有没有写侧的根(`jailFor`)、shell 怎么被包起来(`execFor`)。
 *
 * 判定层（`tools/jail.ts`）只管给定根之后对不对,这一层管的是**有没有根**——
 * 它最容易出错的两种形态都不会报错:该 jail 时返回了 `undefined`（等于护栏没装）,
 * 以及建不出根时静默退回无边界继续跑（用户以为被挡住了）。
 * `execFor` 那一半的两种错法同形:该拦的时候给出 `off`(界面开着而 shell 没装),
 * 以及引擎起不来时给出 `off` 而不是 `unavailable`(静默退回不受限地跑)。
 */

let tmp: string

beforeEach(() => {
  tmp = makeTempDir()
})

afterEach(() => {
  removeTempDir(tmp)
})

describe('缺省即开', () => {
  it('老用户的配置里没有 sandbox 这一键时 jail 是开的:缺键与「显式最严」同一个意思', () => {
    const dir = path.join(tmp, 'workspace')
    fs.mkdirSync(dir)
    expect(jailFor(undefined, dir)?.root).toBe(fs.realpathSync(dir))
    expect(jailFor({}, dir)?.root).toBe(fs.realpathSync(dir))
  })

  it('设置页把开关推到 false 才没有边界:这一支要回到「越界只标注、不拦」', () => {
    const dir = path.join(tmp, 'workspace')
    fs.mkdirSync(dir)
    expect(jailFor({ enabled: false }, dir)).toBeUndefined()
  })

  it('没选工作空间就无处可 jail:那支会话仍走「越界写入一律审批」的老路', () => {
    expect(jailFor(undefined, '')).toBeUndefined()
    expect(jailFor(undefined, '   ')).toBeUndefined()
  })
})

describe('根必须是真身', () => {
  it.skipIf(process.platform === 'win32')(
    '工作空间本身是软链时返回解出来的真身:判定层不再兜根那一侧,漏了这一步就会把根内判成越界',
    () => {
      const real = path.join(tmp, 'real')
      fs.mkdirSync(real)
      const link = path.join(tmp, 'link')
      fs.symlinkSync(real, link, 'dir')
      expect(jailFor(undefined, link)?.root).toBe(fs.realpathSync(real))
    }
  )

  it('工作空间还没被建出来时递归补上:用户选过一个已被删掉的目录不该让整轮没有边界', () => {
    const dir = path.join(tmp, 'nested', 'deeper')
    const jail = jailFor(undefined, dir)
    expect(jail?.root).toBe(fs.realpathSync(dir))
    expect(fs.existsSync(dir)).toBe(true)
  })
})

describe('fail-closed', () => {
  it('根建不出来时抛错而不是返回 undefined:静默退回无边界等于用户以为护栏还在', () => {
    writeFiles(tmp, { blocker: '这是个文件,不能当目录用' })
    const dir = path.join(tmp, 'blocker', 'workspace')
    expect(() => jailFor(undefined, dir)).toThrow(/已不可用/)
  })

  it('那句失败说明是陈述句、点明写入未执行,且不含「请改用 / 务必」这类祈使', () => {
    writeFiles(tmp, { blocker: '这是个文件,不能当目录用' })
    const dir = path.join(tmp, 'blocker', 'workspace')
    let message = ''
    try {
      jailFor(undefined, dir)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain(dir)
    expect(message).toContain('写入未执行')
    expect(message).not.toMatch(/请|务必|必须|应该|不要|换用|改用/)
  })
})

/**
 * `run_command` 那一侧的边界:`execFor` 把设置、jail 根与探针结论合成一份 run 快照。
 *
 * 这一层最容易出的错**都不报错**:该拦的时候返回 `off`(等于护栏没装,而界面看着是开的),
 * 以及引擎起不来时返回 `off` 而不是 `unavailable`(等于静默退回不受限地跑)。
 * 所以断言的重点不在生成的规则长什么样(那在 `sandbox/policy.test.ts`),
 * 而在**三个状态各自什么时候出现、以及非受限那一支绝不带启动方式**。
 */

const SEATBELT: EngineProbeResult = { engine: 'seatbelt', available: true }
const BWRAP: EngineProbeResult = { engine: 'bwrap', available: true }
/** 这台机器没有这种机制(Windows):那是「本来就没有边界」,不是故障 */
const NO_MECHANISM: EngineProbeResult = {
  engine: 'none',
  available: true,
  reason: '这台机器上没有 OS 级的受限执行机制。'
}
/** 该有但装不上(Linux 没 bwrap、mac 引擎变了、规则编译不过) */
const BROKEN: EngineProbeResult = {
  engine: 'bwrap',
  available: false,
  reason: '本机没有 bubblewrap(bwrap),受限执行建立不起来。'
}

/** 收窄到受限那一支:落到其它状态时把整个对象打出来,否则断言失败只说 undefined 不好查 */
function confined(boundary: ExecBoundary): Extract<ExecBoundary, { state: 'confined' }> {
  if (boundary.state !== 'confined') {
    throw new Error(`期望的是 confined,实际是 ${JSON.stringify(boundary)}`)
  }
  return boundary
}

/**
 * 两个引擎都把路径写进 argv,所以「某条路径有没有进边界」两边同一种问法。
 * profile 原样留着(不套一层 JSON),否则 mac 上 `/private/var/…` 把 `/var/…` 含在中间,
 * 「这条规则到底解过真身没有」就查不出来了。
 */
function boundaryText(boundary: Extract<ExecBoundary, { state: 'confined' }>): string {
  return [boundary.launch.file, ...boundary.launch.args, JSON.stringify(boundary.launch.env)].join(
    '\n'
  )
}

describe('execFor:两颗子开关的缺省方向', () => {
  let dir = ''

  beforeEach(() => {
    dir = path.join(makeTempDir(), 'workspace')
    fs.mkdirSync(dir)
  })

  afterEach(() => {
    removeTempDir(path.dirname(dir))
  })

  it('配置里没有 sandbox 这一键时 shell 也进边界,而网络照旧放行', () => {
    const boundary = confined(execFor(undefined, { root: dir }, SEATBELT))
    expect(boundary.engine).toBe('seatbelt')
    // 网络那一颗是对「缺省即最保守」的一条公开例外:关掉它会把装包 / 拉代码一起挡了,
    // 这个取舍由设置页与文档各自写明代价,所以这里钉住方向而不是跟着那条纪律走
    expect(boundary.allowNetwork).toBe(true)
  })

  it('exec 显式关掉时 shell 出边界,而文件 jail 一个字节都不变:两颗开关真的独立', () => {
    expect(execFor({ exec: false }, { root: dir }, SEATBELT)).toEqual({
      state: 'off',
      reason: 'disabled'
    })
    expect(jailFor({ exec: false }, dir)?.root).toBe(fs.realpathSync(dir))
  })

  it('network 关掉才产出拦网络那一条:整条链只有设置页那一个消费者', () => {
    const open = confined(execFor(undefined, { root: dir }, SEATBELT))
    const shut = confined(execFor({ network: false }, { root: dir }, SEATBELT))
    expect(boundaryText(open)).not.toContain('(deny network*)')
    expect(boundaryText(shut)).toContain('(deny network*)')
    // Linux 那边是同一条取舍的另一种写法
    const bwrap = confined(execFor({ network: false }, { root: dir }, BWRAP))
    expect(bwrap.launch.args).toContain('--unshare-net')
  })
})

describe('execFor:三个状态各自什么时候出现', () => {
  it('三种 off 的原因分得清,而用户显式关掉排在最前', () => {
    expect(execFor({ enabled: false }, undefined, NO_MECHANISM)).toEqual({
      state: 'off',
      reason: 'disabled'
    })
    expect(execFor(undefined, undefined, SEATBELT)).toEqual({
      state: 'off',
      reason: 'no-workspace'
    })
    expect(execFor(undefined, { root: '/ws' }, NO_MECHANISM)).toEqual({
      state: 'off',
      reason: 'platform'
    })
  })

  it('引擎装不上只能是 unavailable:混进 off 就等于静默退回不受限地跑', () => {
    const boundary = execFor(undefined, { root: '/ws' }, BROKEN)
    expect(boundary.state).toBe('unavailable')
    expect(boundary.state === 'unavailable' && boundary.reason).toBe(BROKEN.reason)
  })

  it('预检没给原因时也有一句可显示的话,界面不会印出 undefined', () => {
    const boundary = execFor(undefined, { root: '/ws' }, { engine: 'bwrap', available: false })
    expect(boundary.state).toBe('unavailable')
    expect(boundary.state === 'unavailable' ? boundary.reason : '').toBeTruthy()
  })

  it('只有 confined 带启动方式:另外两支漏出 launch 就会被 shell 当成「照着跑」', () => {
    const cases: ExecBoundary[] = [
      execFor({ enabled: false }, { root: '/ws' }, SEATBELT),
      execFor(undefined, undefined, SEATBELT),
      execFor(undefined, { root: '/ws' }, NO_MECHANISM),
      execFor(undefined, { root: '/ws' }, BROKEN)
    ]
    for (const boundary of cases) {
      expect('launch' in boundary).toBe(false)
    }
  })

  it('启动器进 argv 而不是命令串:里面既没有 -c 也没有任何命令本体', () => {
    const mac = confined(execFor(undefined, { root: '/ws' }, SEATBELT))
    expect(mac.launch.file).toBe('/usr/bin/sandbox-exec')
    expect(mac.launch.args[0]).toBe('-p')
    const linux = confined(execFor(undefined, { root: '/ws' }, BWRAP))
    expect(linux.launch.file).toBe('bwrap')
    // 载荷由 `tools/shell.ts` 接在 `--` 之后,所以这一支到此为止
    expect(linux.launch.args[linux.launch.args.length - 1]).toBe('--')
    for (const boundary of [mac, linux]) {
      expect(boundary.launch.args).not.toContain('-c')
      expect(JSON.stringify(boundary.launch.args)).not.toContain('ls -la')
    }
  })

  it('常驻作业的启动器:mac 与前台是同一份,bwrap 只少 die-with-parent 与 new-session', () => {
    const mac = confined(execFor(undefined, { root: '/ws' }, SEATBELT))
    // sandbox-exec 是 exec,不 fork、不换进程组,常驻那一份没有第二种写法
    expect(mac.persistLaunch).toBe(mac.launch)
    const linux = confined(execFor(undefined, { root: '/ws' }, BWRAP))
    expect(linux.persistLaunch).toBeDefined()
    expect(linux.launch.args).toContain('--die-with-parent')
    expect(linux.persistLaunch?.args).not.toContain('--die-with-parent')
    expect(linux.persistLaunch?.args).not.toContain('--new-session')
    expect(linux.persistLaunch?.args[linux.persistLaunch.args.length - 1]).toBe('--')
  })
})

describe('execFor:路径与环境都取真身', () => {
  const home = resolveDeep(os.homedir())
  const sshExists = fs.existsSync(path.join(home, '.ssh'))

  let tmp = ''

  beforeEach(() => {
    tmp = makeTempDir()
  })

  afterEach(() => {
    removeTempDir(tmp)
  })

  it('工作空间取 jail 给的真身:根是软链时按字形进 profile 的那一条静默永不命中', () => {
    const real = path.join(tmp, 'real')
    fs.mkdirSync(real)
    const link = path.join(tmp, 'link')
    fs.symlinkSync(real, link, 'dir')
    const boundary = confined(execFor(undefined, jailFor(undefined, link), SEATBELT))
    expect(boundaryText(boundary)).toContain(fs.realpathSync(real))
    expect(boundaryText(boundary)).not.toContain(link)
  })

  it('临时目录解过真身:env 给的与 profile 放开的必须是同一条,否则 mktemp 的落点在边界外', () => {
    const boundary = confined(execFor(undefined, { root: tmp }, SEATBELT))
    const resolved = resolveDeep(os.tmpdir())
    const raw = os.tmpdir()
    expect(boundary.launch.env.TMPDIR).toBe(resolved)
    // 按 seatbelt 的写法整对引号比:mac 上 `/private/var/…` 把 `/var/…` 含在中间,
    // 不加引号断言的话「没解过的那条」永远查不出来
    const allow = (dir: string): string => `(allow file-write* (subpath ${JSON.stringify(dir)}))`
    expect(boundaryText(boundary)).toContain(allow(resolved))
    if (raw !== resolved) expect(boundaryText(boundary)).not.toContain(allow(raw))
  })

  it('清单里不存在的条目直接不点名:解真身会退到祖先,把整条主目录遮了才是灾难', () => {
    const boundary = confined(execFor(undefined, { root: tmp }, SEATBELT))
    const text = boundaryText(boundary)
    expect(text).not.toContain('cybertiger-test-does-not-exist')
    // 这一条钉的是那一次退化的整张网:home 自身永远存在,被当成祖先解出来就等于遮了整条主目录
    expect(text).not.toContain(`(deny file-read* (subpath ${JSON.stringify(home)}))`)
    if (sshExists) {
      expect(text).toContain(path.join(home, '.ssh'))
    }
  })

  it('env 是白名单:进程环境里的凭据一个都不跟着进沙箱,而 PATH 补了那 8 个目录', () => {
    process.env.SSH_AUTH_SOCK = '/private/tmp/cybertiger-test-agent'
    process.env.CYBERTIGER_SKILLS_DIR = '/tmp/cybertiger-test-skills'
    const boundary = confined(execFor(undefined, { root: tmp }, SEATBELT))
    expect(boundary.launch.env.SSH_AUTH_SOCK).toBeUndefined()
    expect(boundary.launch.env.CYBERTIGER_SKILLS_DIR).toBeUndefined()
    expect(boundary.launch.env.HOME).toBe(home)
    // 打包后的应用 PATH 里只有系统目录:沙箱少这几个目录,`npm` / `npx` 一上手就退出 127
    expect(boundary.launch.env.PATH).toContain('/usr/local/bin')
    expect(boundary.launch.env.PATH).toContain(path.join(home, '.local', 'bin'))
    delete process.env.SSH_AUTH_SOCK
    delete process.env.CYBERTIGER_SKILLS_DIR
  })
})

describe('execFor:清单冲突只拒 shell,文件 jail 那道边界仍然装着', () => {
  const home = resolveDeep(os.homedir())
  const ssh = path.join(home, '.ssh')
  // 只有真有一个 `~/.ssh` 才造得出这两种配置。这里**都不调 `jailFor`**:那会在开发者的
  // `~/.ssh` 底下真建一个目录,而 seatbelt 那一支只用传进来的根生成文本、不碰文件系统
  it.skipIf(!fs.existsSync(ssh))(
    '把工作空间选成了整条主目录时返回 unavailable 而不是抛穿:那等于「随你写任何东西,但凭据读不到」,两个引擎给不出同一个答案',
    () => {
      const boundary = execFor(undefined, { root: home }, SEATBELT)
      expect(boundary.state).toBe('unavailable')
      expect(boundary.state === 'unavailable' ? boundary.reason : '').toContain('清单冲突')
    }
  )

  it.skipIf(!fs.existsSync(ssh))(
    '反过来把工作空间选成凭据目录底下时同样拒:这一支不带启动方式,所以不会有一条看起来装了、实际两边结论相反的边界',
    () => {
      const boundary = execFor(undefined, { root: path.join(ssh, 'keys') }, SEATBELT)
      expect(boundary.state).toBe('unavailable')
      expect('launch' in boundary).toBe(false)
    }
  )
})
