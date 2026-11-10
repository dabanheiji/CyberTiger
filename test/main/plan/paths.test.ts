import fs from 'node:fs'
import path from 'node:path'
import {
  TASK_FILE,
  allocatePlanPaths,
  parseTaskMarkdown,
  planSlug,
  planStamp,
  plansRoot,
  renderTaskMarkdown,
  tasksRoot,
  writeFileAtomic
} from '../../../src/main/plan/paths'
import { makeTempDir, removeTempDir } from '../../helpers/temp'

const originalPlansDir = process.env.CYBERTIGER_PLANS_DIR

afterEach(() => {
  if (originalPlansDir === undefined) delete process.env.CYBERTIGER_PLANS_DIR
  else process.env.CYBERTIGER_PLANS_DIR = originalPlansDir
})

describe('planSlug:从计划第一行标题取一个能建出来的目录名', () => {
  it('取 `# ` 开头的第一行,空白折成连字符', () => {
    expect(planSlug('# 优化 聊天页 的输入区\n\n正文')).toBe('优化-聊天页-的输入区')
  })

  it('中文原样保留:用户要在目录里认出这是哪一份计划', () => {
    expect(planSlug('# 修复登录问题')).toBe('修复登录问题')
  })

  it('去掉各平台不接受的字符与路径分隔符,不让标题变成路径', () => {
    expect(planSlug('# a/b:c*d?"e<f>g|h')).toBe('a-b-c-d-e-f-g-h')
  })

  it('超长标题截到 40 字:再长就只是把整句正文塞进路径', () => {
    const slug = planSlug(`# ${'长'.repeat(60)}`)
    expect(Array.from(slug)).toHaveLength(40)
  })

  it('没有一级标题、标题为空、首尾只有分隔符时退回 plan', () => {
    expect(planSlug('没有标题的正文')).toBe('plan')
    expect(planSlug('#   ')).toBe('plan')
    expect(planSlug('# ---')).toBe('plan')
  })
})

describe('planStamp:本地时间戳', () => {
  it('YYYYMMDD-HHmmss,各段补零', () => {
    expect(planStamp(new Date(2026, 0, 5, 7, 8, 9))).toBe('20260105-070809')
  })
})

describe('plansRoot / tasksRoot:有工作空间跟仓库走,没有就落应用数据目录', () => {
  it('工作空间下是 .cybertiger/plans 与同级的 .cybertiger/tasks', () => {
    const ws = makeTempDir()
    try {
      expect(plansRoot(ws)).toBe(path.join(path.resolve(ws), '.cybertiger', 'plans'))
      expect(tasksRoot(ws)).toBe(path.join(path.resolve(ws), '.cybertiger', 'tasks'))
    } finally {
      removeTempDir(ws)
    }
  })

  it('没有工作空间时用 CYBERTIGER_PLANS_DIR，tasks 取它的兄弟目录', () => {
    const plans = makeTempDir()
    try {
      process.env.CYBERTIGER_PLANS_DIR = plans
      expect(plansRoot('')).toBe(plans)
      expect(tasksRoot('')).toBe(path.join(path.dirname(plans), 'tasks'))
    } finally {
      removeTempDir(plans)
    }
  })
})

describe('allocatePlanPaths:同名计划不互相覆盖', () => {
  it('同一秒、同一标题的第二份改后缀 -2,计划文件与任务目录成对', () => {
    const ws = makeTempDir()
    try {
      const now = new Date(2026, 10, 8, 10, 0, 0)
      const first = allocatePlanPaths(ws, '# 计划标题', now)
      // 真实流程里批准的那一刻会立刻落盘(approvePlan),判重看的是盘上有没有
      writeFileAtomic(first.planPath, '# 计划标题')
      const second = allocatePlanPaths(ws, '# 计划标题', now)
      expect(first.planPath).toBe(
        path.join(ws, '.cybertiger', 'plans', '20261108-100000-计划标题.md')
      )
      expect(first.taskPath).toBe(
        path.join(ws, '.cybertiger', 'tasks', '20261108-100000-计划标题', TASK_FILE)
      )
      expect(second.planPath).toContain('-计划标题-2.md')
      expect(second.taskPath).toContain(path.join('-计划标题-2', TASK_FILE))
    } finally {
      removeTempDir(ws)
    }
  })

  it('只看任务目录已存在也算冲突:两份产物始终同名成对', () => {
    const ws = makeTempDir()
    try {
      const now = new Date(2026, 10, 8, 10, 0, 0)
      const first = allocatePlanPaths(ws, '# 标题', now)
      fs.mkdirSync(path.dirname(first.taskPath), { recursive: true })
      const second = allocatePlanPaths(ws, '# 标题', now)
      expect(second.planPath).toContain('-2.md')
    } finally {
      removeTempDir(ws)
    }
  })
})

describe('writeFileAtomic:不留半截文件', () => {
  it('写完只剩目标文件,没有 .tmp 残留', () => {
    const dir = makeTempDir()
    try {
      const target = path.join(dir, 'nested', 'plan.md')
      writeFileAtomic(target, '# 内容')
      expect(fs.readFileSync(target, 'utf8')).toBe('# 内容')
      expect(fs.existsSync(`${target}.tmp`)).toBe(false)
    } finally {
      removeTempDir(dir)
    }
  })
})

describe('renderTaskMarkdown / parseTaskMarkdown:往返一致', () => {
  it('未完成写成 - [ ],带 1 起的序号与进度', () => {
    const text = renderTaskMarkdown(['第一步', '第二步'])
    expect(text).toContain('# 任务清单')
    expect(text).toContain('进度:0 / 2')
    expect(text).toContain('- [ ] 1. 第一步')
    expect(text).toContain('- [ ] 2. 第二步')
  })

  it('已完成写成 - [x],进度跟着算', () => {
    const text = renderTaskMarkdown(['甲', '乙', '丙'], [1, 3])
    expect(text).toContain('进度:2 / 3')
    expect(text).toContain('- [x] 1. 甲')
    expect(text).toContain('- [ ] 2. 乙')
    expect(text).toContain('- [x] 3. 丙')
  })

  it('解析回来任务与完成序号都能对上', () => {
    const text = renderTaskMarkdown(['甲', '乙', '丙'], [2])
    expect(parseTaskMarkdown(text)).toEqual({ tasks: ['甲', '乙', '丙'], done: [2] })
  })

  it('多行任务压成一行:一条任务不该在清单里占好几行', () => {
    expect(renderTaskMarkdown(['第一行\n第二行'])).toContain('- [ ] 1. 第一行 第二行')
  })

  it('坏行与非任务行被跳过,序号按出现顺序重排', () => {
    const text = [
      '# 任务清单',
      '进度:1 / 2',
      '这行是注释',
      '- [x] 1. 甲',
      '- [ ] 3. 乙',
      '- [ ] 没有序号的旧写法'
    ].join('\n')
    expect(parseTaskMarkdown(text)).toEqual({ tasks: ['甲', '乙'], done: [1] })
  })

  it('空正文不产出条目', () => {
    expect(parseTaskMarkdown('')).toEqual({ tasks: [], done: [] })
    expect(parseTaskMarkdown('- [ ] 1.   ')).toEqual({ tasks: [], done: [] })
  })
})
