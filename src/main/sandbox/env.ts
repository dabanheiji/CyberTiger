import path from 'node:path'

/**
 * 打包后的 macOS / Linux 应用 PATH 里只有系统目录,`npx` / `uvx` 这类命令一律找不到。
 * 这份清单原先长在 `mcp/manager.ts` 里,现在受限执行也要同一份 —— 沙箱里少一个目录,
 * `npm` / `npx` 就退出 127,功能第一次接触就死。一份清单、两个消费者,所以抽到这里。
 */
export function userBinDirs(home: string): string[] {
  return [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.nvm', 'current', 'bin'),
    path.join(home, '.volta', 'bin')
  ]
}

/**
 * 按既有顺序去重追加。win32 原样返回:那侧的 PATH 由系统给,拼 POSIX 目录只会凭空多出看不见的路径。
 */
export function augmentPath(pathValue: string, home: string): string {
  if (process.platform === 'win32') return pathValue
  const current = pathValue.split(':').filter(Boolean)
  for (const dir of userBinDirs(home)) {
    if (!current.includes(dir)) current.push(dir)
  }
  return current.join(':')
}

/**
 * 受限执行的环境变量白名单。**是白名单而不是黑名单**:`*_API_KEY` / `AWS_*` / `GH_TOKEN`
 * 这类名字清单是注定列不全的那一类(与 `risk.ts` 对只读命令清单的判断同一条 —— 列不全的清单
 * 会给读者一个不存在的安全感)。白名单反过来坏在「陌生工具的变量没了 → 命令显式报错」,
 * 那种失败看得见也改得动,而凭据外泄看不见。
 *
 * `XAUTHORITY` **不在名单里**:它是 X11 会话凭据,尽管名字看着无害。
 * `SSH_AUTH_SOCK` 也不在:后果是沙箱里 `git` 走 ssh 会失败,这一条要让人知道,所以写在这里。
 */
const PASS_THROUGH = [
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  '__CF_USER_TEXT_ENCODING'
]

/**
 * 造受限执行那一支用的环境。
 *
 * `home` 与 `tmpdir` **必须是解过真身的那两条**,而且要传给 profile 的正是同两个值:
 * `mktemp -d` 会跟着 `TMPDIR` 落在 `/var/folders/…`,而 profile 只放开 `/private/var/folders/…`,
 * 两边不是同一条字符串时命令里就出现「设了 TMPDIR 反而写不了临时文件」这种无法解释的失败。
 * 缓存同理是**重定向**而不是继承 —— 写侧只放开了 workspace 与 tmpdir,`~/.cargo` 那类
 * 真实缓存目录一律 EPERM,所以把能显式指走的两个指到 tmpdir 底下,其余留给 `writableExtra`。
 */
export function minimalEnv(
  source: Record<string, string | undefined>,
  home: string,
  tmpdir: string
): Record<string, string> {
  const env: Record<string, string> = { PATH: augmentPath(source.PATH ?? '', home), HOME: home }
  for (const key of PASS_THROUGH) {
    const value = source[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  env.TMPDIR = tmpdir
  env.TMP = tmpdir
  env.TEMP = tmpdir
  env.npm_config_cache = path.join(tmpdir, 'cybertiger', 'npm')
  env.PIP_CACHE_DIR = path.join(tmpdir, 'cybertiger', 'pip')
  return env
}
