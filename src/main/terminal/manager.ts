import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Backlog } from './backlog'
import type {
  TerminalCwdSource,
  TerminalEnsureDto,
  TerminalEvent,
  TerminalSessionInfo
} from './dto'
import type { ShellSpec } from './shell'

export const TERMINAL_DEFAULT_COLS = 80
export const TERMINAL_DEFAULT_ROWS = 24
/** 输出批量窗口:短到看不出延迟,又足以把一次构建的碎片输出并成几条 IPC */
export const TERMINAL_FLUSH_INTERVAL_MS = 12
export const TERMINAL_FLUSH_CHARS = 64 * 1024
export const TERMINAL_BACKLOG_CHARS = 256 * 1024

export interface PtyExit {
  exitCode: number
  signal?: number
}

/** manager 只认识这个薄接口,不认识 node-pty 的类型 */
export interface PtyHandle {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(callback: (data: string) => void): void
  onExit(callback: (event: PtyExit) => void): void
}

export interface ResolvedTerminalCwd {
  cwd: string
  cwdSource: TerminalCwdSource
}

export interface TerminalManagerDeps {
  resolveCwd: (conversationId: string | null) => ResolvedTerminalCwd
  shell: () => ShellSpec
  spawn: (spec: ShellSpec, cwd: string, cols: number, rows: number) => PtyHandle
  schedule: (callback: () => void, ms: number) => unknown
  cancel: (handle: unknown) => void
  newId?: () => string
}

interface Session {
  id: string
  cwd: string
  cwdSource: TerminalCwdSource
  shell: string
  pty: PtyHandle
  backlog: Backlog
  /** 已经发出去的最后一个事件序号;回放快照用它挡住重复事件 */
  seq: number
  pending: string
  timer: unknown | null
  exited: boolean
}

/**
 * 终端会话管理。
 *
 * 会话按**解析后的工作目录**去重而不是按会话 id:同一工作空间的两个对话共用一屏,
 * 草稿变成正式会话也不会换 shell。关面板不杀进程(正在跑的构建不该因为收面板就断),
 * 窗口关闭与退出应用统一 `disposeAll`。
 *
 * 依赖全部从构造参数注入,所以复用、批量、回放、清理都能脱离 Electron 与真 PTY 断言。
 */
export class TerminalManager {
  private readonly sessions = new Map<string, Session>()
  private readonly listeners = new Set<(event: TerminalEvent) => void>()

  constructor(private readonly deps: TerminalManagerDeps) {}

  onEvent(listener: (event: TerminalEvent) => void): () => void {
    this.listeners.add(listener)
    return (): void => {
      this.listeners.delete(listener)
    }
  }

  ensure(dto: TerminalEnsureDto): TerminalSessionInfo {
    const { cwd, cwdSource } = this.deps.resolveCwd(dto.conversationId)
    const existing = this.sessions.get(cwd)
    if (existing) return this.info(existing)

    const spec = this.deps.shell()
    const cols = dimension(dto.cols, 2, 500, TERMINAL_DEFAULT_COLS)
    const rows = dimension(dto.rows, 1, 200, TERMINAL_DEFAULT_ROWS)
    let pty: PtyHandle
    try {
      pty = this.deps.spawn(spec, cwd, cols, rows)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`无法启动终端：${reason}（终端组件可能未正确安装）`)
    }

    const session: Session = {
      id: this.deps.newId?.() ?? randomUUID(),
      cwd,
      cwdSource,
      shell: path.basename(spec.file),
      pty,
      backlog: new Backlog(TERMINAL_BACKLOG_CHARS),
      seq: 0,
      pending: '',
      timer: null,
      exited: false
    }
    this.sessions.set(cwd, session)
    pty.onData((data) => this.receive(session, data))
    pty.onExit((event) => this.finish(session, event.exitCode, event.signal))
    return this.info(session)
  }

  write(terminalId: string, data: string): void {
    const session = this.find(terminalId)
    if (!session || session.exited || typeof data !== 'string' || data.length === 0) return
    session.pty.write(data)
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const session = this.find(terminalId)
    if (!session || session.exited) return
    session.pty.resize(
      dimension(cols, 2, 500, TERMINAL_DEFAULT_COLS),
      dimension(rows, 1, 200, TERMINAL_DEFAULT_ROWS)
    )
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) {
      session.exited = true
      if (session.timer !== null) {
        this.deps.cancel(session.timer)
        session.timer = null
      }
      try {
        session.pty.kill()
      } catch (error) {
        console.warn('[terminal] 结束进程失败', error)
      }
    }
    this.sessions.clear()
  }

  private receive(session: Session, data: string): void {
    if (session.exited || !data) return
    session.pending += data
    if (session.pending.length >= TERMINAL_FLUSH_CHARS) {
      this.flush(session)
      return
    }
    if (session.timer === null) {
      session.timer = this.deps.schedule(() => {
        session.timer = null
        this.flush(session)
      }, TERMINAL_FLUSH_INTERVAL_MS)
    }
  }

  private flush(session: Session): void {
    if (session.timer !== null) {
      this.deps.cancel(session.timer)
      session.timer = null
    }
    if (!session.pending) return
    const data = session.pending
    session.pending = ''
    session.seq += 1
    session.backlog.append(data)
    this.emit({ type: 'data', terminalId: session.id, seq: session.seq, data })
  }

  private finish(session: Session, exitCode: number, signal?: number): void {
    if (session.exited) return
    session.exited = true
    this.flush(session)
    if (this.sessions.get(session.cwd) === session) this.sessions.delete(session.cwd)
    this.emit({
      type: 'exit',
      terminalId: session.id,
      code: exitCode,
      ...(signal === undefined ? {} : { signal })
    })
  }

  private info(session: Session): TerminalSessionInfo {
    return {
      terminalId: session.id,
      cwd: session.cwd,
      cwdSource: session.cwdSource,
      shell: session.shell,
      backlog: session.backlog.toString(),
      seq: session.seq
    }
  }

  private find(terminalId: string): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.id === terminalId) return session
    }
    return undefined
  }

  private emit(event: TerminalEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.warn('[terminal] 事件订阅者抛错', error)
      }
    }
  }
}

function dimension(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}
