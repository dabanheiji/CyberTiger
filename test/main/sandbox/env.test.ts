import path from 'node:path'
import { augmentPath, minimalEnv, userBinDirs } from '../../../src/main/sandbox/env'

/**
 * 受限执行那一支的环境变量。
 *
 * 这一层的价值全在「**白名单**」这个选择上:`*_API_KEY` / `AWS_*` / `GH_TOKEN` 那种按名字拦的
 * 清单注定列不全,而列不全的清单会给读者一个不存在的安全感。所以这里的断言不是「脏键被删掉了」
 * 一条一条数,而是「名单之外的一个都不进」——夹具里故意塞满各种形状的凭据名。
 */

/** 一份足够脏的进程环境:每个凭据形状各来一条,外加一条 POSIX 会话里真会有的杂项 */
const DIRTY_SOURCE: Record<string, string> = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/tester',
  USER: 'tester',
  LOGNAME: 'tester',
  SHELL: '/bin/zsh',
  TERM: 'xterm-256color',
  LANG: 'zh_CN.UTF-8',
  LC_ALL: 'zh_CN.UTF-8',
  LC_CTYPE: 'zh_CN.UTF-8',
  DISPLAY: '/tmp/x11-display',
  WAYLAND_DISPLAY: 'wayland-0',
  __CF_USER_TEXT_ENCODING: '0x1F5:0x19:0x34',
  TMPDIR: '/var/folders/xx/T',
  TMP: '/var/folders/xx/T',
  TEMP: '/var/folders/xx/T',
  OPENAI_API_KEY: 'sk-leak',
  ANTHROPIC_API_KEY: 'sk-leak',
  DEEPSEEK_API_KEY: 'sk-leak',
  GH_TOKEN: 'ghp-leak',
  GITHUB_TOKEN: 'ghp-leak',
  NODE_AUTH_TOKEN: 'npm-leak',
  AWS_ACCESS_KEY_ID: 'AKIA-leak',
  AWS_SECRET_ACCESS_KEY: 'leak',
  AWS_PROFILE: 'leak',
  HUGGING_FACE_HUB_TOKEN: 'leak',
  DATABASE_PASSWORD: 'leak',
  DB_PASSWORD: 'leak',
  CLIENT_SECRET: 'leak',
  SESSION_TOKEN: 'leak',
  SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd/x/Listeners',
  XAUTHORITY: '/Users/tester/.Xauthority',
  npm_config__auth: 'bm06bGVhaw==',
  npm_config_registry: 'https://registry.npmjs.org',
  ELECTRON_RUN_AS_NODE: '1',
  ELECTRON_INTERNAL_QUANTUM: '1',
  CYBERTIGER_SKILLS_DIR: '/Users/tester/.cybertiger/skills',
  CYBERTIGER_AGENTS_DIR: '/Users/tester/.cybertiger/agents',
  SOME_UNKNOWN_TOOLVAR: 'leak?'
}

/** 解过真身的临时目录:mac 上 os.tmpdir() 给的是不带 private 的那一条,profile 只认后者 */
const REAL_TMP = '/private/var/folders/xx/T'
const REAL_HOME = '/Users/tester'

describe('白名单的形状', () => {
  it('名单之外一个都不进:凭据按名字拦注定列不全,反过来只放行认得出的键才拦得住', () => {
    const env = minimalEnv(DIRTY_SOURCE, REAL_HOME, REAL_TMP)
    expect(Object.keys(env).sort()).toEqual(
      [
        'DISPLAY',
        'HOME',
        'LANG',
        'LC_ALL',
        'LC_CTYPE',
        'LOGNAME',
        'PATH',
        'PIP_CACHE_DIR',
        'SHELL',
        'TEMP',
        'TERM',
        'TMP',
        'TMPDIR',
        'USER',
        'WAYLAND_DISPLAY',
        '__CF_USER_TEXT_ENCODING',
        'npm_config_cache'
      ].sort()
    )
  })

  it('各类凭据、令牌、密码与 AWS 变量都消失:名字看着无害的 XAUTHORITY 与 SSH_AUTH_SOCK 也一样', () => {
    const env = minimalEnv(DIRTY_SOURCE, REAL_HOME, REAL_TMP)
    for (const key of Object.keys(DIRTY_SOURCE)) {
      if (
        /_API_KEY$|_TOKEN$|_SECRET$|_PASSWORD$|^AWS_|^npm_config_|^ELECTRON_|^CYBERTIGER_|^SSH_|^XAUTHORITY$/i.test(
          key
        )
      ) {
        expect(env, `${key} 不该出现在受限执行的环境里`).not.toHaveProperty(key)
      }
    }
  })

  it('SSH_AUTH_SOCK 被丢掉意味着沙箱里 git 走 ssh 会失败:这条代价要被看见而不是藏在实现里', () => {
    const env = minimalEnv(DIRTY_SOURCE, REAL_HOME, REAL_TMP)
    expect(env).not.toHaveProperty('SSH_AUTH_SOCK')
    expect(env).not.toHaveProperty('XAUTHORITY')
  })

  it('空的值不复制进去:凭空多一条 TERM 空串会让某些命令走不通用的分支而不是回退默认', () => {
    const env = minimalEnv({ PATH: '/usr/bin', TERM: '' }, REAL_HOME, REAL_TMP)
    expect(env).not.toHaveProperty('TERM')
    expect(env.HOME).toBe(REAL_HOME)
  })
})

describe('路径与缓存', () => {
  it('TMPDIR / TMP / TEMP 用的是解过真身的那一条,不是继承来的软链写法:mktemp 落在边界外就是无法解释的失败', () => {
    const env = minimalEnv(DIRTY_SOURCE, REAL_HOME, REAL_TMP)
    expect(env.TMPDIR).toBe(REAL_TMP)
    expect(env.TMP).toBe(REAL_TMP)
    expect(env.TEMP).toBe(REAL_TMP)
  })

  it('缓存是重定向而不是继承:写侧只放开了工作空间与临时目录,继承来的 ~/.cargo 那类一律 EPERM', () => {
    const env = minimalEnv(DIRTY_SOURCE, REAL_HOME, REAL_TMP)
    expect(env.npm_config_cache).toBe(path.join(REAL_TMP, 'cybertiger', 'npm'))
    expect(env.PIP_CACHE_DIR).toBe(path.join(REAL_TMP, 'cybertiger', 'pip'))
    // 但 npm_config_ 那一族其余的(含内嵌凭据的 _auth 与自定 registry)不能跟着进来
    expect(env).not.toHaveProperty('npm_config__auth')
    expect(env).not.toHaveProperty('npm_config_registry')
  })

  it('HOME 保持真实主目录且只有一个:把工作空间当 HOME 会让 git 身份空掉,而 per-run 假 HOME 是读侧那一期的工具', () => {
    const env = minimalEnv(DIRTY_SOURCE, REAL_HOME, REAL_TMP)
    expect(env.HOME).toBe(REAL_HOME)
    expect(Object.keys(env).filter((k) => k === 'HOME')).toHaveLength(1)
  })
})

describe('PATH 的补全', () => {
  it('那 8 个用户级 bin 目录都补进来了:沙箱里少一个目录就是 npm / npx 一律退出 127', () => {
    const env = minimalEnv(DIRTY_SOURCE, REAL_HOME, REAL_TMP)
    for (const dir of userBinDirs(REAL_HOME)) {
      expect(env.PATH.split(':')).toContain(dir)
    }
  })

  it('原有顺序在前、去重、缺失的追加在末尾:把系统目录挤到后面会让沙箱找到别的同名命令', () => {
    const augmented = augmentPath('/usr/bin:/bin:/opt/homebrew/bin', REAL_HOME)
    expect(augmented.split(':').slice(0, 3)).toEqual(['/usr/bin', '/bin', '/opt/homebrew/bin'])
    expect(augmented.split(':')).toHaveLength(2 + userBinDirs(REAL_HOME).length)
  })

  it('空 PATH 也能补出完整的一份:打包后的应用从 Finder 启动时本来就没有 PATH', () => {
    expect(augmentPath('', REAL_HOME)).toBe(userBinDirs(REAL_HOME).join(':'))
  })

  it('win32 原样返回:那侧的 PATH 由系统给,拼一串 POSIX 目录只会凭空多出看不见的路径', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      expect(augmentPath('C:\\Windows\\System32', REAL_HOME)).toBe('C:\\Windows\\System32')
    } finally {
      Object.defineProperty(process, 'platform', original!)
    }
  })
})
