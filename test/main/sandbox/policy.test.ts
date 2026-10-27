import path from 'node:path'
import {
  bwrapArgv,
  canonicalPrivatePaths,
  seatbeltProfile,
  seatbeltString,
  type DeniedPath,
  type ExecPolicyInput
} from '../../../src/main/sandbox/policy'
import { SUB_AGENT_SYSTEM_PROMPT, SYSTEM_PROMPT } from '../../../src/main/agent/prompt'

/**
 * 受限执行的策略生成。
 *
 * 全部断言都对着**生成的文本本身**,不是「包含某几句」:profile 里一条规则写错就是静默的 ——
 * 要么边界根本没装上,要么把命令该用的能力一起关掉,而这两种都不会报错。
 * 所以这里期望值是逐字符写出来的,它同时是这份边界的人工可读版说明书。
 */

/** 一组与真实机器无关的路径:期望值要能被直接读成一份 profile */
function input(over: Partial<ExecPolicyInput> = {}): ExecPolicyInput {
  return {
    workspace: '/real/ws',
    tmpdir: '/private/var/folders/xx/T',
    home: '/Users/tester',
    writableExtra: [],
    allowNetwork: true,
    deniedRead: [
      { path: '/Users/tester/.ssh', directory: true },
      { path: '/Users/tester/.netrc', directory: false }
    ],
    ...over
  }
}

/** 写侧那三行的固定前缀,连 `(deny file-write*)` 一起 —— 顺序是「先关再放开」 */
const HEAD = `(version 1)
(allow default)
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow file-map-executable)
(allow sysctl-read)
(deny file-write*)`

/** `/dev` 那一块是承重的:只有 `(deny file-write*)` 时连 `2>/dev/null` 都 EPERM(实测) */
const DEV =
  '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") ' +
  '(literal "/dev/urandom") (literal "/dev/tty") (literal "/dev/dtracehelper") ' +
  '(regex #"^/dev/tt[yo]") (subpath "/dev/pts"))'

describe('Seatbelt profile 的写侧', () => {
  it('整份 profile 逐字符等于这里写下的那份:边界写错不会报错,只能靠全等断言拦住', () => {
    expect(seatbeltProfile(input())).toBe(
      `${HEAD}
(allow file-write* (subpath "/real/ws"))
(allow file-write* (subpath "/private/var/folders/xx/T"))
${DEV}
(deny file-read* (subpath "/Users/tester/.ssh"))
(deny file-read* (literal "/Users/tester/.netrc"))`
    )
  })

  it('立场是 allow default 而不是 deny default:实测 deny default 会让 node -e 直接 SIGABRT,缺失能力表现为神秘崩溃而不是干净的 EPERM', () => {
    const lines = seatbeltProfile(input()).split('\n')
    expect(lines[1]).toBe('(allow default)')
    expect(lines).not.toContain('(deny default)')
  })

  it('网络默认放行时一个 network 相关的字都不出现:那句 (deny network*) 只有关闭放行才产出', () => {
    expect(seatbeltProfile(input())).not.toMatch(/network/)
  })

  it('关掉网络放行时在末尾追加 (deny network*):它是最后一条,读到文件的人一眼看到当前是收紧态', () => {
    const lines = seatbeltProfile(input({ allowNetwork: false })).split('\n')
    expect(lines[lines.length - 1]).toBe('(deny network*)')
  })

  it('额外的可写目录插在 deny 与 /dev 那块之间:允许写的那几条必须都排在整片关闭之后', () => {
    expect(seatbeltProfile(input({ writableExtra: ['/real/extra'], deniedRead: [] }))).toBe(
      `${HEAD}
(allow file-write* (subpath "/real/ws"))
(allow file-write* (subpath "/private/var/folders/xx/T"))
(allow file-write* (subpath "/real/extra"))
${DEV}`
    )
  })
})

describe('路径的转义与真身', () => {
  it('带空格与双引号的主目录照样写得出合法字面量:实测转义后的 subpath 能编译并命中', () => {
    expect(seatbeltString('/Users/o"b c')).toBe('"/Users/o\\"b c"')
    expect(seatbeltProfile(input({ workspace: '/Users/o"b c/ws', deniedRead: [] }))).toContain(
      '(allow file-write* (subpath "/Users/o\\"b c/ws"))'
    )
  })

  it('反斜杠先于双引号转义:顺序反了就会把给引号加的那个反斜杠再逃一遍', () => {
    expect(seatbeltString('a\\b"c')).toBe('"a\\\\b\\"c"')
  })

  it('清单里的路径都按传入的原样落进规则:解真身是接线那一层的事,这里再解一次就会出现两处真值', () => {
    expect(seatbeltProfile(input({ workspace: '/tmp/ws', deniedRead: [] }))).toContain(
      '(allow file-write* (subpath "/tmp/ws"))'
    )
  })
})

describe('读侧清单与写侧边界的冲突', () => {
  it('工作空间正好在某条凭据目录里时抛错而不是产出一份自相矛盾的 profile:那条允许会把读侧的拒绝合法地打穿', () => {
    expect(() =>
      seatbeltProfile(
        input({
          workspace: '/Users/tester/.ssh',
          deniedRead: [{ path: '/Users/tester/.ssh', directory: true }]
        })
      )
    ).toThrow(/清单冲突/)
  })

  it('临时目录之下的凭据条目同样抛:冲突不看那条允许是哪一侧给的', () => {
    expect(() =>
      seatbeltProfile(
        input({
          tmpdir: '/private/var/folders/xx/T',
          deniedRead: [{ path: '/private/var/folders/xx/T/.ssh', directory: true }]
        })
      )
    ).toThrow(/清单冲突/)
  })

  it('反过来——允许写入的目录正好在凭据目录里面——同样抛:mac 会因为读侧被挡而写不进去,Linux 那边却照样写得进', () => {
    expect(() =>
      seatbeltProfile(
        input({
          workspace: '/Users/tester/.ssh/keys',
          deniedRead: [{ path: '/Users/tester/.ssh', directory: true }]
        })
      )
    ).toThrow(/有包含关系/)
    // 把工作空间选成了整条主目录是同一个洞的另一种形状:每一条凭据路径都落在允许写入的那一条之内
    expect(() => seatbeltProfile(input({ workspace: '/Users/tester' }))).toThrow(/有包含关系/)
  })

  it('那句冲突说明点明两边路径、说明命令未执行,且是不含祈使的陈述句', () => {
    let message = ''
    try {
      seatbeltProfile(
        input({
          workspace: '/Users/tester/.ssh',
          deniedRead: [{ path: '/Users/tester/.ssh', directory: true }]
        })
      )
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('/Users/tester/.ssh')
    expect(message).toContain('命令未执行')
    expect(message).not.toMatch(/请|务必|必须|应该|不要|换用|改用/)
  })

  it('同级但不同目录的名字不算冲突:前缀相同的两个目录不该彼此拦死', () => {
    expect(() =>
      seatbeltProfile(
        input({
          workspace: '/Users/tester/.sshfs',
          deniedRead: [{ path: '/Users/tester/.ssh', directory: true }]
        })
      )
    ).not.toThrow()
  })
})

describe('bwrap 的参数', () => {
  it('旗标顺序、被遮的目录与文件走两种机制、以 -- 收尾:这份数组直接进 spawn,顺序错一个就是换一种失败', () => {
    expect(
      bwrapArgv(input(), '/private/var/folders/xx/T/cybertiger-mask', '/usr/bin:/bin')
    ).toEqual([
      '--die-with-parent',
      '--new-session',
      '--unshare-pid',
      '--unshare-uts',
      '--unshare-ipc',
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      '--bind',
      '/real/ws',
      '/real/ws',
      '--bind',
      '/private/var/folders/xx/T',
      '/private/var/folders/xx/T',
      '--bind',
      '/private/var/folders/xx/T/cybertiger-mask',
      '/Users/tester/.ssh',
      '--ro-bind',
      '/dev/null',
      '/Users/tester/.netrc',
      '--setenv',
      'HOME',
      '/Users/tester',
      '--setenv',
      'TMPDIR',
      '/private/var/folders/xx/T',
      '--setenv',
      'PATH',
      '/usr/bin:/bin',
      '--'
    ])
  })

  it('Linux 这边 --ro-bind / 就是真的 deny-default:所以这台机器上的边界比 mac 那一档硬,文档不许把两者写成同一种强度', () => {
    const argv = bwrapArgv(input({ deniedRead: [] }), '/mask', '/usr/bin')
    expect(argv).toContain('--ro-bind')
    expect(argv.slice(argv.indexOf('--ro-bind'), argv.indexOf('--ro-bind') + 3)).toEqual([
      '--ro-bind',
      '/',
      '/'
    ])
  })

  it('关闭网络放行时多 --unshare-net,放在 pid/uts/ipc 那一组之后、挂载之前', () => {
    const argv = bwrapArgv(input({ allowNetwork: false }), '/mask', '/usr/bin')
    expect(argv).toContain('--unshare-net')
    expect(argv.indexOf('--unshare-net')).toBeLessThan(argv.indexOf('--ro-bind'))
  })

  it('额外的可写目录紧跟 workspace 与 tmpdir 各 bind 一次:构建命令要写工作空间外时靠这一条出口', () => {
    const argv = bwrapArgv(
      input({ writableExtra: ['/real/extra'], deniedRead: [] }),
      '/mask',
      '/usr/bin'
    )
    expect(argv.slice(argv.indexOf('--bind'), argv.indexOf('--bind') + 8)).toEqual([
      '--bind',
      '/real/ws',
      '/real/ws',
      '--bind',
      '/private/var/folders/xx/T',
      '/private/var/folders/xx/T',
      '--bind',
      '/real/extra'
    ])
  })

  it('--setenv 的三条里 TMPDIR 与 profile 放开的那条同串:两边不是同一个真身时 mktemp 会落在边界外', () => {
    const input_ = input({ deniedRead: [] })
    const argv = bwrapArgv(input_, '/mask', '/usr/bin')
    expect(argv[argv.indexOf('TMPDIR') + 1]).toBe(input_.tmpdir)
    expect(seatbeltProfile(input_)).toContain(`(subpath ${seatbeltString(input_.tmpdir)})`)
  })

  it('常驻作业那一份不装 --die-with-parent 与 --new-session:前者让载荷随 bwrap 死,后者会把载荷换进另一个进程组、一次组杀就收不到它', () => {
    const foreground = bwrapArgv(input(), '/mask', '/usr/bin')
    const persist = bwrapArgv(input(), '/mask', '/usr/bin', { persist: true })
    expect(foreground).toContain('--die-with-parent')
    expect(foreground).toContain('--new-session')
    expect(persist).not.toContain('--die-with-parent')
    expect(persist).not.toContain('--new-session')
    // 差别只有那两条旗标:命名空间、挂载、环境与 `--` 收尾一个都不少
    expect(persist.slice(0, 3)).toEqual(['--unshare-pid', '--unshare-uts', '--unshare-ipc'])
    expect(persist).toContain('--ro-bind')
    expect(persist[persist.length - 1]).toBe('--')
    expect(persist.slice(3)).toEqual(foreground.slice(5))
  })
})

describe('读侧点名清单', () => {
  /** 清单里每条都要在两份 system prompt 里有对应的措辞;漂开了就必须红 */
  const MENTIONS: Record<string, string> = {
    '.ssh': '~/.ssh',
    '.aws': '~/.aws',
    '.gnupg': '~/.gnupg',
    '.netrc': '~/.netrc',
    '.git-credentials': '令牌文件',
    '.config/gh': '~/.config/gh',
    'Library/Keychains': '钥匙串'
  }

  it('凭据目录是目录、单个文件是文件:Linux 那边前者的遮法盖空目录、后者遮成空文件,弄反了就遮不住', () => {
    const list = canonicalPrivatePaths('/Users/tester', 'darwin')
    expect(list.map((e) => path.relative('/Users/tester', e.path))).toEqual([
      '.ssh',
      '.aws',
      '.gnupg',
      '.netrc',
      '.git-credentials',
      path.join('.config', 'gh'),
      path.join('Library', 'Keychains')
    ])
    expect(list.map((e) => e.directory)).toEqual([true, true, true, false, false, true, true])
  })

  it('钥匙串只在 mac 上点名:Linux 没有 Library/Keychains 这个路径,凭空多一条只会让人以为挡住了', () => {
    const linux = canonicalPrivatePaths('/home/tester', 'linux')
    expect(linux).toHaveLength(6)
    expect(linux.some((e) => e.path.includes('Keychains'))).toBe(false)
  })

  it('OS 级清单与提示词第 7 条同源:两份各写一套,就会有一份先漂开而读者看不出来', () => {
    const list = canonicalPrivatePaths('/Users/tester', 'darwin')
    for (const entry of list) {
      const rel = path.relative('/Users/tester', entry.path)
      const mention = MENTIONS[rel]
      // 新增条目却忘了在 prompt 里写它:模型仍然会去读,边界却只挡住了这一半
      expect(mention, `${rel} 在 prompt 里没有对应措辞`).toBeDefined()
      expect(SYSTEM_PROMPT).toContain(mention)
      expect(SUB_AGENT_SYSTEM_PROMPT).toContain(mention)
    }
  })

  it('.env 故意不进 OS 清单:工作空间里的 .env 是日常要读的,而 Seatbelt 的 RE2 写不出「工作空间之外的那些」', () => {
    const list = canonicalPrivatePaths('/Users/tester', 'darwin')
    expect(list.some((e) => e.path.endsWith('.env'))).toBe(false)
    // 措辞层面那条还在,别把它当成已经拦住了
    expect(SYSTEM_PROMPT).toContain('.env')
  })

  it('清单逐条进 profile 时目录走 subpath、文件走 literal:写反了 subpath 匹配不到单个文件', () => {
    const list = canonicalPrivatePaths('/Users/tester', 'darwin')
    const profile = seatbeltProfile(input({ deniedRead: list }))
    for (const entry of list) {
      const filter = entry.directory
        ? `(subpath ${seatbeltString(entry.path)})`
        : `(literal ${seatbeltString(entry.path)})`
      expect(profile).toContain(`(deny file-read* ${filter})`)
    }
    const denied = profile.split('\n').filter((line) => line.startsWith('(deny file-read*'))
    expect(denied).toHaveLength(list.length)
  })
})

/** 类型只是给上面这些夹具用的,这条断言保证 DeniedPath 的形状没在重构里悄悄变窄 */
it('DeniedPath 只有 path 与 directory 两个字段:多出第三个字段就说明这一层开始自己猜平台了', () => {
  const entry: DeniedPath = { path: '/x', directory: true }
  expect(Object.keys(entry).sort()).toEqual(['directory', 'path'])
})
