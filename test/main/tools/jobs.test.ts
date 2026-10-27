import fs from 'node:fs'
import path from 'node:path'
import { JobManager } from '../../../src/main/process/jobs'
import { createBackgroundJobTool } from '../../../src/main/tools/jobs'
import type { ToolContext } from '../../../src/main/tools/types'
import { makeTempDir, removeTempDir } from '../../helpers/temp'

/**
 * `background_job` 这一层只做三件事:把 action 归一、把 `jail.exec` 换成启动器、
 * 把 JobManager 的记录翻成给模型看的陈述句。进程管理本身在 `process/jobs.test.ts`。
 */

const STAY = `node -e "console.log('tool job');setInterval(()=>{},1000)"`

let root = ''
let manager: JobManager

beforeEach(() => {
  root = makeTempDir()
  manager = new JobManager({ root })
})

afterEach(async () => {
  await manager.stopAll()
  removeTempDir(root)
})

function context(over: Partial<ToolContext> = {}): ToolContext {
  return { callId: 'call-1', workspace: root, ...over }
}

function tool(): ReturnType<typeof createBackgroundJobTool> {
  return createBackgroundJobTool(manager, 'conv-1')
}

/** 从 start 的返回里认出作业编号(第一行是 `<id> | 运行中 …`) */
function idOf(text: string): string {
  const match = /^(job_[0-9a-f]+) \|/m.exec(text)
  if (!match) throw new Error(`返回里没有作业编号:\n${text}`)
  return match[1]
}

describe('start / logs / stop 的一轮', () => {
  it('start 说清编号、工作目录、日志位置与「活过整轮」,logs 读得到输出,stop 给出结束结论', async () => {
    const background = tool()
    const started = await background.execute(
      { action: 'start', command: STAY, cwd: root },
      context()
    )
    expect(started).toContain('运行中')
    expect(started).toContain(`工作目录: ${root}`)
    expect(started).toContain('日志文件:')
    expect(started).toContain('action=logs')
    const id = idOf(started)

    // 日志是文件,等它写进去
    let logged = ''
    for (let i = 0; i < 100; i += 1) {
      logged = await background.execute({ action: 'logs', job_id: id }, context())
      if (logged.includes('tool job')) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(logged).toContain(`${id} | 运行中`)
    expect(logged).toContain('--- 输出末尾 ---')
    expect(logged).toContain('tool job')

    const listed = await background.execute({ action: 'list' }, context())
    expect(listed).toContain(`本会话的后台作业共 1 个`)
    expect(listed).toContain(id)

    const stopped = await background.execute({ action: 'stop', job_id: id }, context())
    expect(stopped).toContain('已结束')
    expect(stopped).toContain('由你停止')

    // 第二次 stop 不改写结局
    const again = await background.execute({ action: 'stop', job_id: id }, context())
    expect(again).toContain('早已结束')
  }, 15_000)

  it('没有作业时 list 是一句明确的话:模型不该把空列表当成工具坏了', async () => {
    expect(await tool().execute({ action: 'list' }, context())).toBe('本会话没有后台作业。')
  })

  it('命令自己很快结束时,start 直接把输出末尾带回来:不用再多问一次 logs', async () => {
    const result = await tool().execute(
      { action: 'start', command: `node -e "console.log('done now')"`, cwd: root },
      context()
    )
    expect(result).toContain('已结束')
    expect(result).toContain('--- 输出末尾 ---')
    expect(result).toContain('done now')
  })
})

describe('参数与边界', () => {
  it('缺省 action 按 start 算:与审批那一侧的归一保持同一件事', async () => {
    await expect(tool().execute({ command: '' }, context())).rejects.toThrow(/缺少 command/)
  })

  it('认不出的 action 直接拒绝,不猜成 start', async () => {
    await expect(tool().execute({ action: 'restart' }, context())).rejects.toThrow(/action 要是/)
  })

  it('logs / stop 缺 job_id 就拒绝:拿一个空串去查没有意义', async () => {
    await expect(tool().execute({ action: 'logs' }, context())).rejects.toThrow(/缺少 job_id/)
    await expect(tool().execute({ action: 'stop' }, context())).rejects.toThrow(/缺少 job_id/)
  })

  it('受限执行装不上时拒绝 start:绝不退回不受限地常驻', async () => {
    const ctx = context({
      jail: { root, exec: { state: 'unavailable', reason: '本机没有 bubblewrap(bwrap)' } }
    })
    await expect(tool().execute({ action: 'start', command: STAY }, ctx)).rejects.toThrow(/装不上/)
  })

  it('相对 cwd 按会话工作空间锚定:与 run_command 同一条规则', async () => {
    fs.mkdirSync(path.join(root, 'sub'))
    const result = await tool().execute(
      { action: 'start', command: `node -e "process.exit(0)"`, cwd: 'sub' },
      context()
    )
    expect(result).toContain(`工作目录: ${path.join(root, 'sub')}`)
  })
})
