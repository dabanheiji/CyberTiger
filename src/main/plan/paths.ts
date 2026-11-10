import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { projectRoot } from '../project'

/**
 * 计划的落盘位置。
 *
 * 有工作空间时跟着仓库走 —— 计划与任务清单是这次工作的产物,用户换一台机器、换个 clone
 * 也应当看得到:
 *   <ws>/.cybertiger/plans/<stamp>-<slug>.md
 *   <ws>/.cybertiger/tasks/<stamp>-<slug>/task.md
 *
 * 没有工作空间时落到应用数据目录下同名两份:
 *   <userData>/plans/...  与  <userData>/tasks/...
 *
 * 两份都只在「用户批准计划」的那一刻才真正建目录与写文件 —— 规划阶段一个字都不落盘。
 */
export const PLANS_DIR = 'plans'
export const TASKS_DIR = 'tasks'
export const TASK_FILE = 'task.md'

/** 计划标题转目录名后的长度上限:再长就只是把路径变成一句正文 */
const SLUG_MAX = 40
/** 同名冲突时的尝试次数上限;超过说明目录里攒了几十份同一个标题的计划 */
const UNIQUE_MAX = 50

/** 全局 plans 目录;测试用 CYBERTIGER_PLANS_DIR 指到临时目录 */
function globalPlansRoot(): string {
  const override = process.env.CYBERTIGER_PLANS_DIR
  if (override && override.trim()) return path.resolve(override.trim())
  return path.join(app.getPath('userData'), PLANS_DIR)
}

export function plansRoot(workspace: string): string {
  const root = projectRoot(workspace)
  return root ? path.join(root, PLANS_DIR) : globalPlansRoot()
}

/** tasks 永远与 plans 同级:同一个工作空间下两份产物挨在一起,离了工作空间也一样 */
export function tasksRoot(workspace: string): string {
  const root = projectRoot(workspace)
  if (root) return path.join(root, TASKS_DIR)
  return path.join(path.dirname(globalPlansRoot()), TASKS_DIR)
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本地时间戳 YYYYMMDD-HHmmss;用它而不是 uuid,是为了让人在目录里一眼认出先后 */
export function planStamp(now: Date = new Date()): string {
  return (
    `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
    `-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
  )
}

/**
 * 从计划正文的第一行 `# 标题` 取一个目录名。
 *
 * 保留中文(用户读得懂),去掉路径分隔符与各平台不接受的字符 —— 含这些字符的名字在
 * 某些文件系统上会直接建不出来,而计划本身没有任何问题;截 40 字是因为再长就只是把
 * 标题整句塞进路径。取不到标题时叫 `plan`,空目录名是建不出来的。
 */
export function planSlug(plan: string): string {
  const heading = plan
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('# '))
  const title = heading ? heading.slice(2).trim() : ''
  // 控制字符逐字判定而不是写进正则:字符类里的 \u001f 会被 lint 的 no-control-regex 拦下,
  // 而这里要的只是「这个字符在路径里不合适」
  const cleaned = Array.from(title)
    .map((ch) => (/[\\/:*?"<>|]/.test(ch) || ch.charCodeAt(0) < 32 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  const slug = Array.from(cleaned).slice(0, SLUG_MAX).join('')
  return slug || 'plan'
}

function exists(target: string): boolean {
  try {
    fs.statSync(target)
    return true
  } catch {
    return false
  }
}

/**
 * 分配这一份计划的两个路径并建出目录。
 *
 * 判重看的是「计划文件或任务目录任一已存在」:两份产物同名时,后来那份改后缀 `-2`,
 * 于是同一秒批准两份同标题的计划不会互相覆盖 —— 覆盖一份已批准的计划等于把用户
 * 已经看过的内容换掉。
 */
export function allocatePlanPaths(
  workspace: string,
  plan: string,
  now: Date = new Date()
): { planPath: string; taskPath: string } {
  const plansDir = plansRoot(workspace)
  const tasksDir = tasksRoot(workspace)
  const base = `${planStamp(now)}-${planSlug(plan)}`

  fs.mkdirSync(plansDir, { recursive: true })
  fs.mkdirSync(tasksDir, { recursive: true })

  for (let index = 1; index <= UNIQUE_MAX; index += 1) {
    const name = index === 1 ? base : `${base}-${index}`
    const planPath = path.join(plansDir, `${name}.md`)
    const taskDir = path.join(tasksDir, name)
    if (!exists(planPath) && !exists(taskDir)) {
      return { planPath, taskPath: path.join(taskDir, TASK_FILE) }
    }
  }
  throw new Error(`无法为计划分配文件名:${plansDir} 下已有 ${UNIQUE_MAX} 份同名计划`)
}

/** 先落临时文件再改名:半截文件比没有文件更难排查,而这份是用户会被指过去读的 */
export function writeFileAtomic(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, target)
}

/** 任务清单里的条数上限;再多也执行不完,只会让完成度变成一句空话 */
export const TASKS_MAX = 50
/** 单条任务的字符上限;一条任务要能被一句话读懂 */
export const TASK_TEXT_MAX = 200

function progress(done: number, total: number): string {
  return `进度:${done} / ${total}`
}

function normalizeTask(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' ').trim()
}

/**
 * `task.md` 的正文。
 * 已完成用 `- [x]`,未完成用 `- [ ]`;序号从 1 起且写进每一行,模型按序号勾选,
 * 不必自己数第几条。
 */
export function renderTaskMarkdown(tasks: readonly string[], done: readonly number[] = []): string {
  const doneSet = new Set(done)
  const finished = tasks.filter((_, index) => doneSet.has(index + 1)).length
  const lines = ['# 任务清单', '', progress(finished, tasks.length), '']
  tasks.forEach((task, index) => {
    const mark = doneSet.has(index + 1) ? 'x' : ' '
    lines.push(`- [${mark}] ${index + 1}. ${normalizeTask(task)}`)
  })
  return `${lines.join('\n')}\n`
}

const TASK_LINE = /^\s*-\s*\[(x| )\]\s*(\d+)\.\s*(.*)$/i

export interface ParsedTasks {
  tasks: string[]
  /** 1 起的序号,升序 */
  done: number[]
}

/**
 * 从 `task.md` 读回清单与进度。
 *
 * 磁盘是唯一事实来源:工具每次现读,所以重启、换界面、模型中途忘了都不会把进度丢掉。
 * 序号取行里的那一个而不是「第几条」,这样手工在文件里加一行注释也不会让勾选错位;
 * 行里的序号重复或越界时按出现顺序重新编号,坏文件也读得出一份可用的清单。
 */
export function parseTaskMarkdown(text: string): ParsedTasks {
  const tasks: string[] = []
  const done = new Set<number>()
  for (const line of text.split('\n')) {
    const match = TASK_LINE.exec(line)
    if (!match) continue
    const body = match[3].trim()
    if (!body) continue
    tasks.push(body)
    if (match[1].toLowerCase() === 'x') done.add(tasks.length)
  }
  return { tasks, done: [...done].sort((a, b) => a - b) }
}
