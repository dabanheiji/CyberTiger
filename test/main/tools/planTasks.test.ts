import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPlanTasksTool } from '../../../src/main/tools/planTasks'
import { TASK_FILE, TASKS_MAX, TASK_TEXT_MAX } from '../../../src/main/plan/paths'
import type { ToolContext } from '../../../src/main/tools/types'
import { makeTempDir, removeTempDir } from '../../helpers/temp'

/**
 * `plan_tasks` 的全部行为都写在 `task.md` 上:磁盘是唯一事实来源。
 * 所以每个用例只关心一件事 —— 这一次调用之后文件里有什么、模型看到什么。
 */
describe('plan_tasks', () => {
  let root: string
  let taskPath: string

  const ctx: ToolContext = { callId: 'call_test' }

  beforeEach(() => {
    root = makeTempDir()
    taskPath = path.join(root, 'tasks', '20260101-000000-demo', TASK_FILE)
  })

  afterEach(() => {
    removeTempDir(root)
  })

  function tool(): ReturnType<typeof createPlanTasksTool> {
    return createPlanTasksTool(taskPath)
  }

  it('首次给 tasks 就建出任务文件,并回显整份清单', async () => {
    const result = await tool().execute(
      { tasks: ['读 plan/paths.ts', '加一个工具', '写用例'] },
      ctx
    )

    expect(result).toContain('已把 3 条任务写入任务文件')
    expect(result).toContain('进度:0 / 3')
    expect(result).toContain('1. [ ] 读 plan/paths.ts')
    expect(result).toContain('3. [ ] 写用例')
    const onDisk = fs.readFileSync(taskPath, 'utf8')
    expect(onDisk).toContain('# 任务清单')
    expect(onDisk).toContain('- [ ] 1. 读 plan/paths.ts')
  })

  it('重复给 tasks 不覆盖已有进度,只回报当前清单', async () => {
    await tool().execute({ tasks: ['第一步', '第二步'] }, ctx)
    await tool().execute({ done: [1] }, ctx)

    const result = await tool().execute({ tasks: ['换一套完全不同的清单'] }, ctx)

    expect(result).toContain('任务清单已经存在')
    expect(result).toContain('1. [x] 第一步')
    expect(result).toContain('2. [ ] 第二步')
    expect(result).not.toContain('换一套完全不同的清单')
    expect(fs.readFileSync(taskPath, 'utf8')).toContain('- [x] 1. 第一步')
  })

  it('done 勾掉指定序号并报出剩余条目', async () => {
    await tool().execute({ tasks: ['a', 'b', 'c'] }, ctx)

    const first = await tool().execute({ done: [1] }, ctx)
    expect(first).toContain('已标记完成:第 1 条')
    expect(first).toContain('进度 1 / 3')
    expect(first).toContain('剩余:第 2 条、第 3 条')

    const second = await tool().execute({ done: [2, 3] }, ctx)
    expect(second).toContain('已标记完成:第 2 条、第 3 条')
    expect(second).toContain('进度 3 / 3')
    expect(second).toContain('计划中的所有任务都已完成')
  })

  it('同一序号重复勾选不会把进度算多', async () => {
    await tool().execute({ tasks: ['a', 'b'] }, ctx)

    const result = await tool().execute({ done: [1, 1] }, ctx)
    expect(result).toContain('进度 1 / 2')
  })

  it('非法序号给一句陈述,指出合法范围', async () => {
    await tool().execute({ tasks: ['a', 'b'] }, ctx)

    await expect(tool().execute({ done: [3] }, ctx)).rejects.toThrow(/不是有效序号.*1 到 2/)
    await expect(tool().execute({ done: [0] }, ctx)).rejects.toThrow(/不是有效序号/)
    expect(fs.readFileSync(taskPath, 'utf8')).not.toContain('[x]')
  })

  it('两个参数都不给时返回当前清单,供模型自查', async () => {
    const before = tool()
    await expect(before.execute({}, ctx)).rejects.toThrow(/任务文件还不存在/)

    await before.execute({ tasks: ['a', 'b'] }, ctx)
    const result = await before.execute({}, ctx)
    expect(result).toContain('进度:0 / 2')
    expect(result).toContain('1. [ ] a')
    expect(result).toContain('2. [ ] b')
  })

  it('任务条数超上限就拒绝,并点名上限', async () => {
    const tooMany = Array.from({ length: TASKS_MAX + 1 }, (_, i) => `第 ${i + 1} 步`)
    await expect(tool().execute({ tasks: tooMany }, ctx)).rejects.toThrow(
      new RegExp(`超过上限 ${TASKS_MAX}`)
    )
    expect(fs.existsSync(taskPath)).toBe(false)
  })

  it('单条任务超字数就拒绝,不写半截文件', async () => {
    const long = 'x'.repeat(TASK_TEXT_MAX + 1)
    await expect(tool().execute({ tasks: ['正常', long] }, ctx)).rejects.toThrow(
      new RegExp(`超过单条上限 ${TASK_TEXT_MAX}`)
    )
    expect(fs.existsSync(taskPath)).toBe(false)
  })

  it('空清单与全是空白的清单都拒绝', async () => {
    await expect(tool().execute({ tasks: [] }, ctx)).rejects.toThrow(/任务清单是空的/)
    await expect(tool().execute({ tasks: ['  ', '\n'] }, ctx)).rejects.toThrow(/任务清单是空的/)
    expect(fs.existsSync(taskPath)).toBe(false)
  })

  it('单条任务里的换行被压成一行,不会把清单撑成好几行', async () => {
    const result = await tool().execute({ tasks: ['先读代码\n再写计划'] }, ctx)
    expect(result).toContain('1. [ ] 先读代码 再写计划')
    expect(result.split('\n').filter((line) => line.startsWith('1. '))).toHaveLength(1)
  })
})
