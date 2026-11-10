import { shellSpec } from '../../../src/main/terminal/shell'

const HOME = '/Users/tester'

describe('shellSpec 的 shell 选择', () => {
  it('POSIX 优先用 $SHELL,并带 -l 读用户自己的 profile', () => {
    const spec = shellSpec('darwin', { SHELL: '/opt/homebrew/bin/fish' }, HOME)
    expect(spec.file).toBe('/opt/homebrew/bin/fish')
    expect(spec.args).toEqual(['-l'])
  })

  it('mac 没有 $SHELL 时回落 zsh:系统默认的那个,别硬塞一个用户没装的 shell', () => {
    expect(shellSpec('darwin', {}, HOME).file).toBe('/bin/zsh')
  })

  it('Linux 没有 $SHELL 时回落 bash', () => {
    expect(shellSpec('linux', {}, HOME).file).toBe('/bin/bash')
  })

  it('$SHELL 不是绝对路径就不认:裸名字交给 node-pty 会按 PATH 猜,起不来时没有线索', () => {
    expect(shellSpec('linux', { SHELL: 'fish' }, HOME).file).toBe('/bin/bash')
  })

  it('Windows 用 PowerShell,并关掉那行版权横幅', () => {
    const spec = shellSpec('win32', {}, HOME)
    expect(spec.file).toBe('powershell.exe')
    expect(spec.args).toEqual(['-NoLogo'])
  })
})

describe('shellSpec 的环境变量', () => {
  it('抹掉 Electron 注入的三个变量:留给孩子 shell 只会让基于 Electron 的工具按 node 跑', () => {
    const spec = shellSpec(
      'darwin',
      {
        SHELL: '/bin/zsh',
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_NO_ATTACH_CONSOLE: '1',
        NODE_OPTIONS: '--inspect'
      },
      HOME
    )
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(spec.env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined()
    expect(spec.env.NODE_OPTIONS).toBeUndefined()
  })

  it('其余用户变量原样保留:这不是 sandbox 的白名单环境,凭据与工具变量必须还在', () => {
    const spec = shellSpec(
      'darwin',
      { SHELL: '/bin/zsh', OPENAI_API_KEY: 'sk-test', EDITOR: 'vim' },
      HOME
    )
    expect(spec.env.OPENAI_API_KEY).toBe('sk-test')
    expect(spec.env.EDITOR).toBe('vim')
  })

  it('POSIX 补终端色彩与语言:LANG 缺省会让中文与 emoji 在部分 shell 里坏掉', () => {
    const spec = shellSpec('linux', { SHELL: '/bin/bash' }, HOME)
    expect(spec.env.TERM).toBe('xterm-256color')
    expect(spec.env.COLORTERM).toBe('truecolor')
    expect(spec.env.LANG).toBe('en_US.UTF-8')
  })

  it('用户自己设了 LANG 就不覆盖', () => {
    expect(shellSpec('linux', { LANG: 'zh_CN.UTF-8' }, HOME).env.LANG).toBe('zh_CN.UTF-8')
  })

  it('Windows 的 PATH 原样返回:那侧由系统给,拼 POSIX 目录只会多出看不见的路径', () => {
    const spec = shellSpec('win32', { PATH: 'C:\\Windows' }, HOME)
    expect(spec.env.PATH).toBe('C:\\Windows')
    expect(spec.env.TERM).toBeUndefined()
  })
})
