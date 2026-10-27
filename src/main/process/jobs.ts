import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import type { ExecLaunch } from '../sandbox'
import { describeFsError } from '../tools/paths'
import { groupAlive, killGroup, pidAlive } from './kill'
import { spawnProc } from './spawn'

/** 一个会话同时能挂几个作业:再多的等待时间线也没人看得过来 */
export const MAX_JOBS_PER_CONVERSATION = 5
/** 全局上限:作业是常驻进程,堆到十几个就是机器在替模型记事 */
export const MAX_JOBS_TOTAL = 10

/** 启动确认窗:这么长时间内既没退出也没报错,就算「起来了」 */
const START_CONFIRM_MS = 400
/** SIGTERM 之后给它这么久;还不退就 SIGKILL */
const STOP_GRACE_MS = 800
/** SIGKILL 之后再等这么久,不等它把 exit 事件报回来 */
const STOP_KILL_WAIT_MS = 400
/** 退出应用时最多花这么久收拾全部作业 */
const STOP_ALL_BUDGET_MS = 3_000

/** 日志文件保留多久:过期日志在下次启动清扫时删掉 */
const LOG_TTL_MS = 24 * 60 * 60 * 1000

export type JobStatus = 'running' | 'exited' | 'stopped' | 'lost'

/**
 * 这次结束是谁造成的。
 *
 * `external` 是**别人杀的**(用户在工作台里 kill、系统 OOM):它既不是超时也不是中止,
 * 混进任何一边都会让模型得出错误结论(「我再跑一次就好了」/「用户不让我做」)。
 */
export type JobEndBy = 'natural' | 'stopped' | 'app-quit' | 'conversation-deleted' | 'external'

export interface JobRecord {
  id: string
  conversationId: string
  command: string
  cwd: string
  pid: number
  startedAt: number
  logPath: string
  status: JobStatus
  exitCode: number | null
  signal: string
  endedAt: number | null
  by: JobEndBy | null
}

export interface StartJobInput {
  conversationId: string
  command: string
  cwd: string
  /** 前台那一次的启动器(受限执行关着时为空) */
  launch?: ExecLaunch
  /**
   * 常驻作业用的启动器。
   *
   * 与 `launch` 的差别只在 bwrap 的旗标:作业要活过这一次工具调用,所以不能装
   * `--die-with-parent`;也不装 `--new-session`,载荷留在 bwrap 的进程组里,
   * `stop` 的一次组杀才收得掉它。seatbelt 那一侧是 `exec`,两者本来就是同一份。
   */
  persistLaunch?: ExecLaunch
}

function defaultRoot(): string {
  return path.join(os.tmpdir(), 'cybertiger', 'jobs')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 归属证明:这条 pid 上的进程是不是当初那个。
 *
 * 只看 pid 会误杀 —— 机器重启后 pid 被另一个进程复用,清一条旧记录就把别人的进程杀了。
 * 所以拿 `ps` 给的启动时刻与记录里的 `startedAt` 比(±3 秒),
 * **证明不了就不杀**,只把记录丢掉:宁留一个孤儿进程,也不误杀一个无辜的。
 */
function sameProcess(record: JobRecord): boolean {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(record.pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      timeout: 1_000
    }).trim()
    if (!out) return false
    const startedAt = new Date(out).getTime()
    return Number.isFinite(startedAt) && Math.abs(startedAt - record.startedAt) <= 3_000
  } catch {
    return false
  }
}

/** 读文件末尾,按字节窗口读而不是整份读进来:日志可以有好几 MB */
function readTail(file: string, maxChars: number): string {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const bytes = Math.min(size, Math.max(8_192, maxChars * 4))
    const buffer = Buffer.alloc(bytes)
    fs.readSync(fd, buffer, 0, bytes, Math.max(0, size - bytes))
    // 从字节窗口中间开始解,头一个字符可能是半个字,换成替换符再剥掉
    const text = buffer.toString('utf8').replace(/^\uFFFD+/, '')
    return text.length > maxChars ? text.slice(text.length - maxChars) : text
  } catch {
    return ''
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

export class JobManager {
  private readonly root: string
  private readonly records = new Map<string, JobRecord>()
  private readonly children = new Map<string, ChildProcess>()

  constructor(options: { root?: string } = {}) {
    this.root = options.root ?? defaultRoot()
  }

  /** 启动一个后台作业。返回时它要么已经在跑,要么已经退出;起不来则抛错 */
  async start(input: StartJobInput): Promise<JobRecord> {
    this.assertCapacity(input.conversationId)
    fs.mkdirSync(this.root, { recursive: true })
    const id = `job_${randomUUID().replace(/-/g, '').slice(0, 8)}`
    const logPath = path.join(this.root, `${id}.log`)
    const fd = fs.openSync(logPath, 'a')

    let child: ChildProcess
    try {
      child = spawnProc({
        command: input.command,
        cwd: input.cwd,
        launch: input.persistLaunch ?? input.launch,
        // 输出接在文件上而不是管道上:攥着管道会让「这次调用结束了」永远等不到
        io: { kind: 'file', fd },
        // 归属标记:重启后按它认领孤儿(见 sweep 那一侧对 ps 的比对)
        env: { CYBERTIGER_JOB: id }
      })
    } catch (error) {
      fs.closeSync(fd)
      throw new Error(`命令无法启动(cwd=${input.cwd}):${describeFsError(error)}`)
    }
    // 子进程已经拿到自己那份 fd
    fs.closeSync(fd)

    const record: JobRecord = {
      id,
      conversationId: input.conversationId,
      command: input.command,
      cwd: input.cwd,
      pid: child.pid ?? 0,
      startedAt: Date.now(),
      logPath,
      status: 'running',
      exitCode: null,
      signal: '',
      endedAt: null,
      by: null
    }
    this.records.set(id, record)
    this.children.set(id, child)
    // 作业不该替应用续命:Electron 里无所谓,单测里一条没停掉的作业会把整个 run 挂住
    child.unref()

    let spawnFailure = ''
    child.on('exit', (code, signalName) => this.onExit(record, code, signalName ?? ''))
    child.on('error', (error) => this.onError(record, error))
    this.writeRegistry()

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), START_CONFIRM_MS)
      const done = (): void => {
        clearTimeout(timer)
        resolve()
      }
      child.once('exit', done)
      child.once('error', (error) => {
        spawnFailure = describeFsError(error)
        done()
      })
    })

    if (spawnFailure) throw new Error(`命令无法启动(cwd=${input.cwd}):${spawnFailure}`)
    return record
  }

  list(conversationId: string): JobRecord[] {
    this.refreshLiveness()
    return [...this.records.values()]
      .filter((record) => record.conversationId === conversationId)
      .sort((a, b) => a.startedAt - b.startedAt)
  }

  /** 日志末尾 + 状态行;作业不存在或不属于这个会话时报错,不泄露别的会话的作业 */
  logs(conversationId: string, id: string, maxChars = 4_000): { record: JobRecord; text: string } {
    const record = this.find(conversationId, id)
    this.refreshLiveness()
    return { record, text: readTail(record.logPath, maxChars) }
  }

  async stop(conversationId: string, id: string): Promise<JobRecord> {
    const record = this.find(conversationId, id)
    if (record.status !== 'running') return record
    return this.terminate(record, 'stopped')
  }

  /** 会话被删时把它名下的作业一起带走,日志文件也不留 */
  dispose(conversationId: string): void {
    for (const record of [...this.records.values()]) {
      if (record.conversationId !== conversationId) continue
      if (record.status === 'running') void this.terminate(record, 'conversation-deleted')
      this.records.delete(record.id)
      this.children.delete(record.id)
      try {
        fs.unlinkSync(record.logPath)
      } catch {
        // 已经不在了
      }
    }
    this.writeRegistry()
  }

  /** 退出应用时的总清理:有总预算,不能被一个杀不掉的进程拖住退出 */
  async stopAll(): Promise<void> {
    const running = [...this.records.values()].filter((record) => record.status === 'running')
    await Promise.race([
      Promise.all(running.map((record) => this.terminate(record, 'app-quit'))),
      delay(STOP_ALL_BUDGET_MS)
    ])
    this.writeRegistry()
  }

  /**
   * 启动时清扫上一次留下的作业。
   *
   * 只处理「磁盘上有记录、进程还活着、且启动时刻对得上」的那几条;
   * 对不上就把记录丢掉、进程留着 —— 那条纪律是「宁留孤儿,不误杀」。
   * Windows 上没有 `ps` 可问,这一步直接跳过(记录照样清掉)。
   */
  sweep(): void {
    const stale = this.readRegistry()
    if (process.platform !== 'win32') {
      for (const record of stale) {
        if (!pidAlive(record.pid) && !groupAlive(record.pid)) continue
        if (!sameProcess(record)) continue
        killGroup(record.pid, 'SIGKILL')
      }
    }
    this.pruneLogs()
    this.writeRegistry()
  }

  private find(conversationId: string, id: string): JobRecord {
    const record = this.records.get(id)
    if (!record || record.conversationId !== conversationId) {
      throw new Error(`没有找到这个后台作业:${id}`)
    }
    return record
  }

  private assertCapacity(conversationId: string): void {
    const running = [...this.records.values()].filter((record) => record.status === 'running')
    const mine = running.filter((record) => record.conversationId === conversationId).length
    if (mine >= MAX_JOBS_PER_CONVERSATION) {
      throw new Error(
        `这个会话已经有 ${mine} 个后台作业在运行(上限 ${MAX_JOBS_PER_CONVERSATION}),` +
          '没有启动新作业'
      )
    }
    if (running.length >= MAX_JOBS_TOTAL) {
      throw new Error(`后台作业总数已达上限 ${MAX_JOBS_TOTAL},没有启动新作业`)
    }
  }

  private onExit(record: JobRecord, code: number | null, signal: string): void {
    record.exitCode = code
    record.signal = signal
    record.endedAt = Date.now()
    if (record.by === null) {
      // 没人给它发过信号却带着信号退出,只可能是别人杀的
      record.by = signal ? 'external' : 'natural'
      record.status = 'exited'
    } else {
      record.status = 'stopped'
    }
    // 直接子进程走了,组里可能还留着它派生的进程(`sh -c 'server &'` 那种) ——
    // 作业已经从 list 的「运行中」里消失,再不收掉就没人认领它们了
    if (groupAlive(record.pid)) killGroup(record.pid, 'SIGTERM')
    this.children.delete(record.id)
    this.writeRegistry()
  }

  private onError(record: JobRecord, error: unknown): void {
    if (record.status !== 'running') return
    record.status = 'lost'
    record.endedAt = Date.now()
    record.by = 'external'
    record.signal = ''
    record.exitCode = null
    this.children.delete(record.id)
    this.registryNote(record, describeFsError(error))
    this.writeRegistry()
  }

  /** 起不来时把原因写进日志,否则 `logs` 只会给一个空文件 */
  private registryNote(record: JobRecord, message: string): void {
    try {
      fs.appendFileSync(record.logPath, `[启动失败] ${message}\n`)
    } catch {
      // 日志写不了不影响结论
    }
  }

  private async terminate(record: JobRecord, by: JobEndBy): Promise<JobRecord> {
    if (record.status !== 'running') return record
    // 先写下「是谁发的信号」再发:进程可能在下一行之前就退出,
    // 那条 exit 事件要靠它把结论写成「被停止」而不是「外部杀死」
    record.by = by
    killGroup(record.pid, 'SIGTERM')

    const graceDeadline = Date.now() + STOP_GRACE_MS
    while (Date.now() < graceDeadline && groupAlive(record.pid)) await delay(50)
    if (groupAlive(record.pid)) {
      killGroup(record.pid, 'SIGKILL')
      const killDeadline = Date.now() + STOP_KILL_WAIT_MS
      while (Date.now() < killDeadline && groupAlive(record.pid)) await delay(50)
    }

    // exit 事件没到也照样给出结论:等待表不能因为一个异常的子进程永远挂着
    if (record.status === 'running') {
      record.status = 'stopped'
      record.endedAt = Date.now()
      this.children.delete(record.id)
      this.writeRegistry()
    }
    return record
  }

  /** 组里一个都不剩、而 exit 事件没到(极少数情形):就地判为已结束 */
  private refreshLiveness(): void {
    let changed = false
    for (const record of this.records.values()) {
      if (record.status !== 'running') continue
      if (groupAlive(record.pid)) continue
      record.status = 'exited'
      record.endedAt = record.endedAt ?? Date.now()
      changed = true
    }
    if (changed) this.writeRegistry()
  }

  private pruneLogs(): void {
    let names: string[]
    try {
      names = fs.readdirSync(this.root)
    } catch {
      return
    }
    const cutoff = Date.now() - LOG_TTL_MS
    for (const name of names) {
      if (!name.endsWith('.log')) continue
      const file = path.join(this.root, name)
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file)
      } catch {
        // 别人删了 / 删不掉,都留到下次
      }
    }
  }

  private writeRegistry(): void {
    try {
      fs.mkdirSync(this.root, { recursive: true })
      const running = [...this.records.values()].filter((record) => record.status === 'running')
      fs.writeFileSync(path.join(this.root, 'index.json'), JSON.stringify(running))
    } catch {
      // 索引只是给下一次启动清扫用的,写不了不影响作业本身
    }
  }

  private readRegistry(): JobRecord[] {
    try {
      const raw = fs.readFileSync(path.join(this.root, 'index.json'), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter((item): item is JobRecord => {
        const record = item as JobRecord
        return typeof record?.id === 'string' && typeof record?.pid === 'number'
      })
    } catch {
      return []
    }
  }
}

/** 进程内唯一的一份:作业归应用所有,不归某一次 run */
export const jobManager = new JobManager()
