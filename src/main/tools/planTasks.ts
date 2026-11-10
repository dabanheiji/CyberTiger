import fs from 'fs'
import {
  TASK_FILE,
  TASK_TEXT_MAX,
  TASKS_MAX,
  parseTaskMarkdown,
  renderTaskMarkdown,
  writeFileAtomic,
  type ParsedTasks
} from '../plan/paths'
import { confine } from './jail'
import type { ToolDefinition } from './types'

/**
 * 本次计划的任务清单工具。
 *
 * 任务文件在批准计划时就已经分配好路径(`chat/service.ts` 的 `approvePlan`),这里只
 * 负责读写那一个文件 —— 参数里没有路径,模型也无从把它指到别处。进度以磁盘为准:
 * 每次调用现读 `task.md`,所以重启、重载、模型忘了做到第几步都不会把已完成的项丢掉。
 */
export function createPlanTasksTool(taskPath: string): ToolDefinition {
  return {
    name: 'plan_tasks',
    description:
      `维护本次计划的实施任务清单(文件:${TASK_FILE})。` +
      '第一次调用必须给 tasks:按执行顺序列出计划里的每一步,工具会建立任务文件并返回清单。' +
      '此后每完成一步,用 done 给出已完成任务的序号(从 1 起),工具会勾掉它们并返回剩余条目与进度;' +
      '两个参数都不给时返回当前清单与进度,用来核对还差哪几步。' +
      '任务文件已经存在时,再给 tasks 不会覆盖它(那会抹掉已有进度),工具只返回当前清单。' +
      `一次最多 ${TASKS_MAX} 条任务,单条不超过 ${TASK_TEXT_MAX} 字。` +
      '任务文件由本工具写,不需要也不应该用 write_file。',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: { type: 'string' },
          description: '任务清单,按执行顺序;只在第一次调用时给'
        },
        done: {
          type: 'array',
          items: { type: 'number' },
          description: '已完成的任务序号(从 1 起);可以一次给多个'
        }
      }
    },
    execute: async (args, context): Promise<string> => {
      // jail 开着时拿真身去读写:判完字形再 open 原路径,软链那一头会绕开边界
      const file = context.jail ? confine(taskPath, context.jail.root) : taskPath
      const existing = readTasks(file)

      if (args.tasks !== undefined) {
        const tasks = normalizeTasks(args.tasks)
        if (existing) {
          return (
            `任务清单已经存在,不能用 tasks 覆盖已有进度。\n` +
            formatTasks(file, existing.tasks, existing.done)
          )
        }
        writeFileAtomic(file, renderTaskMarkdown(tasks))
        return `已把 ${tasks.length} 条任务写入任务文件。\n${formatTasks(file, tasks, [])}`
      }

      if (!existing) {
        throw new Error(
          `任务文件还不存在:${file}。第一次调用要用 tasks 给出任务清单,例如 {"tasks":["第一步", "第二步"]}`
        )
      }

      if (args.done !== undefined) {
        const marked = normalizeDone(args.done, existing.tasks.length)
        if (marked.length === 0) return formatTasks(file, existing.tasks, existing.done)
        const merged = [...new Set([...existing.done, ...marked])].sort((a, b) => a - b)
        writeFileAtomic(file, renderTaskMarkdown(existing.tasks, merged))
        const remaining = existing.tasks
          .map((_, index) => index + 1)
          .filter((index) => !merged.includes(index))
        const tail =
          remaining.length === 0
            ? '计划中的所有任务都已完成。'
            : `剩余:${remaining.map((index) => `第 ${index} 条`).join('、')}`
        return (
          `已标记完成:${marked.map((index) => `第 ${index} 条`).join('、')}。` +
          `进度 ${merged.length} / ${existing.tasks.length};${tail}\n` +
          formatTasks(file, existing.tasks, merged)
        )
      }

      return formatTasks(file, existing.tasks, existing.done)
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readTasks(file: string): ParsedTasks | null {
  try {
    return parseTaskMarkdown(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`读取任务文件 ${file} 失败:${errorText(error)}`)
  }
}

/** 单条任务压成一行:换行会让一条任务在清单里占好几行,勾选与核对都跟着变难 */
function oneLine(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' ').trim()
}

function normalizeTasks(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('tasks 要是字符串数组,每一项是一条任务')
  const tasks: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('tasks 里的每一项都必须是字符串')
    const text = oneLine(item)
    if (!text) continue
    if (text.length > TASK_TEXT_MAX) {
      throw new Error(
        `第 ${tasks.length + 1} 条任务有 ${text.length} 字,超过单条上限 ${TASK_TEXT_MAX};` +
          '把一条拆成两条,或者删掉不必要的描述'
      )
    }
    tasks.push(text)
  }
  if (tasks.length === 0) throw new Error('tasks 里没有可用的任务条目,任务清单是空的')
  if (tasks.length > TASKS_MAX) {
    throw new Error(`任务有 ${tasks.length} 条,超过上限 ${TASKS_MAX};先按阶段合并成更粗的步骤`)
  }
  return tasks
}

function normalizeDone(value: unknown, total: number): number[] {
  if (!Array.isArray(value)) throw new Error('done 要是任务序号数组,序号从 1 起')
  const done: number[] = []
  for (const item of value) {
    const index = typeof item === 'number' ? item : Number(String(item).trim())
    if (!Number.isInteger(index) || index < 1 || index > total) {
      throw new Error(
        `done 里的 ${String(item)} 不是有效序号:任务一共 ${total} 条,序号从 1 到 ${total}`
      )
    }
    done.push(index)
  }
  return [...new Set(done)].sort((a, b) => a - b)
}

function formatTasks(file: string, tasks: readonly string[], done: readonly number[]): string {
  const doneSet = new Set(done)
  const finished = tasks.filter((_, index) => doneSet.has(index + 1)).length
  const rows = tasks.map(
    (task, index) => `${index + 1}. ${doneSet.has(index + 1) ? '[x]' : '[ ]'} ${task}`
  )
  const lines = [`任务文件:${file}`, `进度:${finished} / ${tasks.length}`, ...rows]
  if (tasks.length > 0 && finished === tasks.length) lines.push('计划中的所有任务都已完成。')
  return lines.join('\n')
}
