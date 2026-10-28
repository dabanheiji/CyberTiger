import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { store } from '../store'
import type { SandboxExecStatus, SandboxSettings } from '../store/types'
import { resolveHookCommand } from './contract'
import { buildHookFile, parseHookFile } from './parser'
import type { HookDraft, HookEvent, HookMeta } from './types'
import type { HookRow } from './dto'

export const HOOK_FILE = 'HOOK.md'

/**
 * 钩子目录:`userData/hooks/<name>/HOOK.md`。
 *
 * 与 skills / agents 同一个环境变量接缝(`CYBERTIGER_HOOKS_DIR`),所以注册表与启停语义
 * 能脱离应用跑单测;**测试里不要调 `init()`**,它会 `fs.watch` 并留下监听句柄。
 */
export function hooksDir(): string {
  return process.env.CYBERTIGER_HOOKS_DIR || path.join(app.getPath('userData'), 'hooks')
}

/** 原子写:先落临时文件再改名,否则 fs.watch 可能读到半截内容并把列表闪成错误态 */
function writeHookFile(dir: string, content: string): void {
  const target = path.join(dir, HOOK_FILE)
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, target)
}

/**
 * 这一条钩子**在这台机器上**跑在哪一侧。
 *
 * 界面只能回答全局那一半:「有没有选工作空间」是每条会话的事,所以受限那一档写的是
 * 「需要本次会话选了工作空间」,而某一次真实的结论永远在日志与 payload 里(见 `boundary.ts`)。
 * 三种情形必须各说各的:Windows 上把「已启用沙箱」印在界面上就是说谎。
 */
export function runsAsLabel(
  sandboxed: boolean,
  sandbox: SandboxSettings | undefined,
  status: SandboxExecStatus | undefined
): string {
  if (!sandboxed) return '未受限(默认)'
  if (sandbox?.enabled === false) return '未受限(沙箱已被你关掉)'
  if (sandbox?.exec === false) return '未受限(「把命令关进受限执行环境」那一颗关着)'
  if (status === undefined) return '受限(需要本次会话选了工作空间)'
  if (status.engine === 'none') return '未受限(这台机器没有对应的机制)'
  if (!status.available) return '不会运行(受限执行在这台机器上不可用)'
  return '受限(需要本次会话选了工作空间)'
}

/**
 * 钩子声明目录的注册表:磁盘是唯一事实来源,设置页只是它的编辑器。
 *
 * 与 skills / agents 同一套形状(启动扫描 + `fs.watch` 防抖 300ms + 变更广播),
 * 但启停仍然走 electron-store 的 `disabledHooks` 而不是文件里的键:磁盘上写下 HOOK.md
 * 即「用户要它」,而关掉一条是应用侧的状态,不该让用户去改自己写的声明文件。
 */
class HookRegistry {
  private hooks: HookMeta[] = []
  private listeners = new Set<(hooks: HookMeta[]) => void>()
  private watcher: fs.FSWatcher | null = null
  private rescanTimer: NodeJS.Timeout | null = null
  private queue: Promise<unknown> = Promise.resolve()

  init(): void {
    fs.mkdirSync(hooksDir(), { recursive: true })
    this.scan()
    this.watch()
  }

  onChange(listener: (hooks: HookMeta[]) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.hooks)
  }

  private watch(): void {
    try {
      this.watcher = fs.watch(hooksDir(), { recursive: true }, () => this.scheduleRescan())
      this.watcher.on('error', (error) => console.error('[hooks] watch error:', error))
    } catch (error) {
      console.error('[hooks] 无法监听目录:', error)
    }
  }

  private scheduleRescan(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null
      this.scan()
      this.notify()
    }, 300)
  }

  /**
   * 重新扫描目录。解析失败的目录也进列表,但带 `error` 且视为不可用 ——
   * 设置页要能指出「是哪一条、为什么」,而不是让它凭空消失。
   */
  scan(): void {
    const root = hooksDir()
    const disabled = new Set(store.get('disabledHooks') ?? [])
    const rootReal = this.realroot(root)
    const found: HookMeta[] = []
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch (error) {
      // 目录还没建出来(首次启动前没人 mkdir)不算失败:那本来就是「一条钩子都没装」
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[hooks] 读取目录失败:', error)
      }
    }

    for (const entry of entries) {
      // 目录名就是身份,所以软链目录一律不当作一条钩子:那样「装进去的声明」与「跑的那个文件」
      // 可以分属两地,而界面上看不出区别
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dir = path.join(root, entry.name)
      try {
        const content = this.readDeclaration(dir, rootReal)
        const parsed = parseHookFile(content, dir, entry.name)
        found.push({ ...parsed, enabled: !disabled.has(parsed.name) })
      } catch (error) {
        found.push({
          name: entry.name,
          description: '',
          event: 'beforeAgent',
          command: '',
          args: [],
          matcher: [],
          sandboxed: false,
          timeoutMs: 10_000,
          once: false,
          doc: '',
          dir,
          enabled: false,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    // fs.readdir 的顺序不是契约,而多个钩子的说明顺序、否决优先级与改写级联必须是确定的
    found.sort((a, b) => a.name.localeCompare(b.name))
    this.hooks = found
  }

  /**
   * 读声明本身,并做**两次**判定:字形上必须在 hooks 目录内,真身也必须在。
   *
   * `HOOK.md` 是指向别处的软链时,只查字形等于「界面上写着这条钩子装在 hooks/x,
   * 实际内容读的是另一个文件」。与 `tools/jail.ts`、`skills/registry.ts` 同一条纪律。
   */
  private readDeclaration(dir: string, rootReal: string): string {
    const file = path.join(dir, HOOK_FILE)
    if (!fs.existsSync(file)) throw new Error(`目录里没有 ${HOOK_FILE}`)
    const real = fs.realpathSync(file)
    if (!this.inside(real, rootReal)) {
      throw new Error(`${HOOK_FILE} 指向了 hooks 目录之外:${real}`)
    }
    return fs.readFileSync(real, 'utf8')
  }

  private realroot(root: string): string {
    try {
      return fs.realpathSync(root)
    } catch {
      // 根还不存在时没有可比较的真身:用字形兜住,随后的逐条 realpath 仍会各自判一次
      return path.normalize(root)
    }
  }

  private inside(target: string, root: string): boolean {
    return target === root || target.startsWith(root + path.sep)
  }

  /** 设置页看的每一行(含解析失败项) */
  rows(status: SandboxExecStatus | undefined): HookRow[] {
    const sandbox = store.get('sandbox')
    return this.hooks.map((meta) => {
      // 声明解析失败时 command 是空串,不解析(那会解出 hooks 目录本身,界面上看着像「路径对上了」)
      const resolvedPath = meta.error ? '' : resolveHookCommand(meta).file
      return {
        meta,
        error: meta.error,
        resolvedPath,
        runsAs: runsAsLabel(meta.sandboxed, sandbox, status)
      }
    })
  }

  list(): HookMeta[] {
    return this.hooks
  }

  get(name: string): HookMeta | undefined {
    return this.hooks.find((h) => h.name === name)
  }

  /**
   * 启用的、解析成功的钩子;`event` 传了只取那一个时机。
   *
   * 一次 run 只在开头取一次快照(与审批名单同一条纪律):跑到一半改钩子时,
   * 已发出的那些调用按哪份算说不清。
   */
  getEnabled(event?: HookEvent): HookMeta[] {
    return this.hooks.filter(
      (h) => h.enabled && !h.error && (event === undefined || h.event === event)
    )
  }

  /** 重扫目录并广播;任何直接改动目录的路径都必须走这里 */
  refresh(): void {
    this.scan()
    this.notify()
  }

  setEnabled(name: string, enabled: boolean): void {
    const hook = this.require(name)
    const disabled = new Set(store.get('disabledHooks') ?? [])
    if (enabled) disabled.delete(hook.name)
    else disabled.add(hook.name)
    store.set('disabledHooks', [...disabled])
    this.refresh()
  }

  create(draft: HookDraft): Promise<void> {
    return this.serialize(() => {
      const { name, content } = buildHookFile(draft)
      const dir = path.join(hooksDir(), name)
      if (fs.existsSync(dir)) throw new Error(`钩子 "${name}" 已存在`)
      fs.mkdirSync(dir, { recursive: true })
      try {
        writeHookFile(dir, content)
      } catch (error) {
        fs.rmSync(dir, { recursive: true, force: true })
        throw error
      }
      this.refresh()
    })
  }

  update(previousName: string, draft: HookDraft): Promise<void> {
    return this.serialize(() => {
      const target = this.require(previousName)
      const { name, content } = buildHookFile(draft)

      if (name === target.name) {
        writeHookFile(target.dir, content)
        this.refresh()
        return
      }

      // 改名:先在新目录写完再删旧目录,中途失败不会两头都丢
      const nextDir = path.join(hooksDir(), name)
      if (fs.existsSync(nextDir)) throw new Error(`钩子 "${name}" 已存在`)
      fs.mkdirSync(nextDir, { recursive: true })
      try {
        writeHookFile(nextDir, content)
        fs.rmSync(target.dir, { recursive: true, force: true })
      } catch (error) {
        fs.rmSync(nextDir, { recursive: true, force: true })
        throw error
      }

      // 启停跟着钩子走,不因改名而丢掉
      const disabled = new Set(store.get('disabledHooks') ?? [])
      if (disabled.delete(target.name)) {
        if (!target.enabled) disabled.add(name)
        store.set('disabledHooks', [...disabled])
      }
      this.refresh()
    })
  }

  remove(name: string): Promise<void> {
    return this.serialize(() => {
      const target = this.require(name)
      fs.rmSync(target.dir, { recursive: true, force: true })
      const disabled = new Set(store.get('disabledHooks') ?? [])
      if (disabled.delete(target.name)) store.set('disabledHooks', [...disabled])
      this.refresh()
    })
  }

  /** 串行执行写操作;前一个失败不影响后一个 */
  private serialize<T>(fn: () => T): Promise<T> {
    const next = this.queue.then(fn)
    this.queue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private require(name: string): HookMeta {
    const hook = this.get(name)
    if (!hook) throw new Error(`钩子 "${name}" 不存在`)
    return hook
  }
}

export const hookRegistry = new HookRegistry()
