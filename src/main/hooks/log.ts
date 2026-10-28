import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { HookExecution } from './dto'

/**
 * 钩子的观测面:`userData/logs/hooks.jsonl`,一次触发一行。
 *
 * 为什么是一份文件而不是一批界面事件:两个钩子 × 11 步就是每回合二十来次触发,
 * 那是审计量级而不是对话内容;而 `useAgentStream` 的 switch 末尾会清掉整轮流式状态,
 * 为它新增事件类型要配的是一条承重 case,换来的信息与这份文件完全等价。
 *
 * **这里没有对话正文。** `beforeRequest` 的 payload 里是整份出站消息,而它们一条都不写进来:
 * 把会话原文再抄一份到另一份追加文件里,等于给用户的机器上多留一份不设防的聊天记录。
 * 改写的采纳与否只写成 `rewritten` 与 `msgCount`。
 */

/** 轮转的两个阈值:先到哪个算哪个。1 MiB 大约装得下一千行结论,而翻聊天记录不该翻一份日志 */
const MAX_BYTES = 1024 * 1024
const MAX_LINES = 1000

/** 「最近执行」那张表的默认行数;上限由界面自己传,这里只兜一个默认值 */
export const DEFAULT_RECENT_LINES = 50

/** 一行 JSONL 的字段下限:文件是追加写的,但用户可以手工编辑,读的时候按外部输入对待 */
function looksLikeRow(value: unknown): value is HookExecution {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.ts === 'string' &&
    typeof row.hook === 'string' &&
    typeof row.event === 'string' &&
    typeof row.decision === 'string'
  )
}

/**
 * 日志路径,带一个环境变量接缝(`CYBERTIGER_HOOKS_LOG`)。
 *
 * 与 `CYBERTIGER_HOOKS_DIR` 同一条理由,但这里更具体:electron 替身把所有用例的 `userData`
 * 指向**同一个**默认目录,而轮转那一条要往这份文件里塞上千行 —— 没有接缝就会和别的用例互踩。
 */
export function hooksLogPath(): string {
  return (
    process.env.CYBERTIGER_HOOKS_LOG || path.join(app.getPath('userData'), 'logs', 'hooks.jsonl')
  )
}

/**
 * 串行写:同一个文件被多个会话同时追加时,`appendFile` 之间会插进半行。
 * 先例是 `skills/installer.ts` 的那条队列 —— 同一条理由,同一形状。
 */
let queue: Promise<unknown> = Promise.resolve()

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => undefined)
  return next
}

/** 读全文再取末尾若干行重写一遍。文件已被上限钉死在 1 MiB 内,所以整份读进内存是安全的 */
function rotate(file: string): void {
  const lines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-MAX_LINES)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${lines.join('\n')}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 记一次触发。
 *
 * **永不抛、永不 reject**:日志写不进去(磁盘满、权限、目录被用户删了)不能把一次工具调用
 * 改成失败,也不能把一轮 run 停在观测面上。坏了只在控制台留一句,界面上「最近执行」空着
 * 就是它坏了的信号。
 */
export function recordHook(exec: HookExecution): Promise<void> {
  return serialized(async () => {
    try {
      const file = hooksLogPath()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, `${JSON.stringify(exec)}\n`, 'utf8')
      if (fs.statSync(file).size > MAX_BYTES) rotate(file)
    } catch (error) {
      console.error('[hooks] 日志写入失败:', error instanceof Error ? error.message : String(error))
    }
  })
}

/**
 * 最近 N 行,**新的在前**(设置页那张表就按这个顺序铺)。
 *
 * 解析不动的行直接跳过:一行坏了不能把整张表变成空白,也不能把「上一次失败」那条唯一的线索
 * 一起带走。
 */
export function recentHooks(limit: number = DEFAULT_RECENT_LINES): HookExecution[] {
  const want = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_RECENT_LINES
  let text: string
  try {
    text = fs.readFileSync(hooksLogPath(), 'utf8')
  } catch {
    return []
  }
  const rows: HookExecution[] = []
  for (const line of text
    .split('\n')
    .filter((one) => one.trim() !== '')
    .slice(-want)) {
    try {
      const parsed: unknown = JSON.parse(line)
      if (looksLikeRow(parsed)) rows.push(parsed)
    } catch {
      // 半行(上一次写到一半被杀)与手工编辑的坏行都从这里出去
    }
  }
  return rows.reverse()
}
