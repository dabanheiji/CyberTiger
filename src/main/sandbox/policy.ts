import path from 'node:path'

/**
 * 受限执行的策略生成:输入是**已经解过真身**的几条路径,输出是给 `sandbox-exec` / `bwrap` 的那份文本。
 *
 * 这一层不碰 `fs`、不碰 `child_process`、不碰 electron —— 边界写错就是静默的,能脱离应用逐行断言
 * 是它存在的唯一理由。路径的 realpath 由接线那层(`sandbox/index.ts` 借 `tools/jail.ts` 的
 * `resolveDeep`)负责,这里收到的字符串就是内核看到的那一条。
 *
 * **mac 那一档是 `allow default` + `(deny file-write*)` + 更具体的 allow-back,不是 `deny default`。**
 * 实测:`(deny default)` 下 `node -e` 直接 SIGABRT(退出码 134),缺失能力表现为神秘崩溃而不是
 * 干净的 `Operation not permitted` —— 一个 4b 的小模型读到崩溃只会重试,读到 EPERM 才知道是边界。
 * 真白名单那一份要等「最小可执行系统」那一期的工,不在这次混做。
 * 反过来 `bwrap --ro-bind / /` 天然就是 deny-default,所以 **Linux 上这道边界比 mac 硬**,
 * 文档里不许把两者写成同一种强度。
 */

export interface DeniedPath {
  /** 已 realpath 过的绝对路径 */
  path: string
  /** 目录走 `subpath`(Linux 那边盖一层空目录),单个文件走 `literal`(那边遮成空文件) */
  directory: boolean
}

export interface ExecPolicyInput {
  /** = `jail.root`:本次会话的工作空间,唯一项目内可写的目录 */
  workspace: string
  /** `os.tmpdir()` 解过的真身。mac 上是 `/private/var/folders/…`,不解就一条规则都不命中 */
  tmpdir: string
  /** 解过的真实主目录,只用来生成读侧的点名清单(不受限执行那一支不会走到这里) */
  home: string
  /** 额外的可写目录。一期接线固定传空数组,留着给「构建命令要写工作空间外」那条出口 */
  writableExtra: string[]
  /** false 才产出 `(deny network*)` / `--unshare-net`;缺省由设置那侧给(默认放行) */
  allowNetwork: boolean
  /** `canonicalPrivatePaths` 的产物逐条解过真身 */
  deniedRead: DeniedPath[]
}

/**
 * 读侧点名的凭据清单。**与 `agent/prompt.ts` 第 7 条那一份同源**,单测里逐条去 system prompt 查存在 ——
 * 漂开了就必须红。
 *
 * `.env` **故意不在这里**:工作空间里的 `.env` 是日常要读的,而 Seatbelt 的 RE2 写不出
 * 「工作空间之外的所有 `.env`」(没有先行断言),这条继续留在措辞层面。
 * 钥匙串也不在这份清单之外敞着的那一条之外 —— 它走 `securityd` 这个 mach 服务,
 * 只 deny 文件路径挡不住 `security find-generic-password`,那条 `global-name` 没实测确认就不写。
 */
export function canonicalPrivatePaths(
  home: string,
  platform: NodeJS.Platform = process.platform
): DeniedPath[] {
  const entries: Array<[string, boolean]> = [
    ['.ssh', true],
    ['.aws', true],
    ['.gnupg', true],
    ['.netrc', false],
    ['.git-credentials', false],
    [path.join('.config', 'gh'), true]
  ]
  if (platform === 'darwin') entries.push([path.join('Library', 'Keychains'), true])
  return entries.map(([rel, directory]) => ({ path: path.join(home, rel), directory }))
}

/** Seatbelt 的字符串字面量:`"` 与 `\` 都要逃,包在双引号里 */
export function seatbeltString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** 纯文本的前缀包含:`candidate` 是 `root` 本身或在其之下。收到的都已解真身,所以文本比较够用 */
function within(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * 要保护的目录与允许写入的目录**有包含关系** —— 任一方向都是冲突。
 *
 * 这条不是洁癖:同一个区域既进 allow-back 又进 deny 时,**谁赢取决于引擎的次序与它怎么分类操作** ——
 * 点名目录在可写根之内(Linux 的 `--bind` 后写的盖掉前写的、遮成空目录,于是往那儿写会落进掩蔽目录;
 * mac 那边写与读是两条 operation,allow-back 会在 deny 上合法地打个洞)、
 * 反过来可写根在点名目录之内(mac 会因为 traversal 被 `file-read*` 挡着而写不进去,Linux 却照样能写)。
 * 一份两边结论不同的边界比没有边界更难排查,所以两个方向都直接拒。
 * 一期接线 `writableExtra` 是空的,触发的都是「把工作空间选成了 `~` 或 `~/.ssh` 底下」这类配置 ——
 * 看着像误伤,但那正是该让人看一眼的时候:拒掉命令并说明是哪两条路径,比给出一条静默的、换平台就变的边界好。
 * 抛的是陈述句(与 `jailFor`、`confine` 同一条纪律)。
 */
function assertNoOverlap(input: ExecPolicyInput): void {
  const writable = [input.workspace, input.tmpdir, ...input.writableExtra]
  for (const denied of input.deniedRead) {
    const hit = writable.find((root) => within(denied.path, root) || within(root, denied.path))
    if (hit) {
      throw new Error(
        `受限执行的清单冲突:${denied.path} 与允许写入的 ${hit} 有包含关系,` +
          '两个引擎对这种配置给出的结论不一样,命令未执行'
      )
    }
  }
}

/** 只有 `(deny file-write*)` 而不放开 `/dev` 时,连 `echo x > /dev/null` 都会 EPERM(实测) */
const DEV_WRITABLE =
  '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") ' +
  '(literal "/dev/urandom") (literal "/dev/tty") (literal "/dev/dtracehelper") ' +
  '(regex #"^/dev/tt[yo]") (subpath "/dev/pts"))'

/**
 * 生成 Seatbelt profile。行序即这里写下的行序:先声明立场(`allow default`)、再补上依赖
 * (`process-*` 那几条)、然后整片写侧关掉并按「更具体者赢」逐条放开、最后点名读侧与网络。
 * 命中按具体度而不是书写顺序(实测),但按这个顺序产出让将来读文件的人不必记那条规则。
 */
export function seatbeltProfile(input: ExecPolicyInput): string {
  assertNoOverlap(input)
  const writable = [input.workspace, input.tmpdir, ...input.writableExtra].map(
    (dir) => `(allow file-write* (subpath ${seatbeltString(dir)}))`
  )
  const lines: string[] = [
    '(version 1)',
    '(allow default)',
    // 下面 5 条 `allow default` 已经蕴含。照写是因为它们说清了这份 profile 依赖什么能力,
    // 而将来收紧成白名单时不必回来补;signal 那条还把信号语义留在 jail 内部。
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow file-map-executable)',
    '(allow sysctl-read)',
    '(deny file-write*)',
    ...writable,
    DEV_WRITABLE
  ]
  for (const denied of input.deniedRead) {
    const filter = denied.directory
      ? `(subpath ${seatbeltString(denied.path)})`
      : `(literal ${seatbeltString(denied.path)})`
    lines.push(`(deny file-read* ${filter})`)
  }
  if (!input.allowNetwork) lines.push('(deny network*)')
  return lines.join('\n')
}

/**
 * 生成 bwrap 的参数,**以 `--` 结尾**;载荷(`-- <bash> -c <command>`)由调用方接在后面。
 *
 * 被点名的目录不是「拒绝读」而是「盖一层空目录」:于是命令看到的是目录存在但列不出内容,
 * 而 mac 那边是 `Operation not permitted`。两种表现都在结果那一句边界说明里盖住,
 * 不在这里统一 —— 内核给的错本来就不给统一的。
 *
 * `maskDir` 是接线那层预创建的一个空目录(在 `tmpdir` 之下,因此两条边都在沙箱里可见)。
 * 选它而不是 `--tmpfs`:目录在不在都走同一条机制,不用加分支。
 */
export function bwrapArgv(
  input: ExecPolicyInput,
  maskDir: string,
  pathValue: string,
  options: { persist?: boolean } = {}
): string[] {
  const argv: string[] = []
  // 常驻作业这两条都不能装:
  //   - `--die-with-parent` 让载荷在 bwrap 一死就跟着死,而 stop 杀的正是 bwrap;
  //   - `--new-session` 会把载荷放进它自己的会话(即自己的进程组),
  //     于是 `kill(-bwrapPid)` 的组杀只收得到 bwrap,载荷活下来。
  // 丢掉 `--new-session` 不削弱防护:bwrap 本身就是以 detached 起的,载荷这一侧
  // 从来没有控制终端,TIOCSTI 那条攻击面在这里不存在。
  if (!options.persist) argv.push('--die-with-parent', '--new-session')
  argv.push('--unshare-pid', '--unshare-uts', '--unshare-ipc')
  if (!input.allowNetwork) argv.push('--unshare-net')
  argv.push('--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc')
  for (const dir of [input.workspace, input.tmpdir, ...input.writableExtra]) {
    argv.push('--bind', dir, dir)
  }
  for (const denied of input.deniedRead) {
    if (denied.directory) argv.push('--bind', maskDir, denied.path)
    else argv.push('--ro-bind', '/dev/null', denied.path)
  }
  argv.push('--setenv', 'HOME', input.home)
  argv.push('--setenv', 'TMPDIR', input.tmpdir)
  argv.push('--setenv', 'PATH', pathValue)
  argv.push('--')
  return argv
}
