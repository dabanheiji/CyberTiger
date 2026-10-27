import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { JobManager, MAX_JOBS_PER_CONVERSATION } from '../../../src/main/process/jobs'
import { groupAlive, killGroup, pidAlive } from '../../../src/main/process/kill'
import { makeTempDir, removeTempDir } from '../../helpers/temp'

/**
 * 后台作业的进程管理。
 *
 * 这里跑的是**真实子进程**:作业的全部意义就是「活过这次调用」,用假进程验不出
 * 「组杀收得掉孙子」「外部 kill 不被误报成超时」「重启后不误杀无辜」这三件事。
 * 每条用例结束时都必须把进程收干净,否则一条 failed 的用例会留下一个常驻 node。
 */

const CONV = 'conv-1'

/** 一条会一直跑的命令:进程自己活着,组里也只有它 */
const STAY = `node -e "console.log('job up');setInterval(()=>{},1000)"`

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`等待超时(${timeoutMs}ms):条件一直没有成立`)
}

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

describe('启动、列表与日志', () => {
  it('启动后立刻进 list,输出写进日志文件:它不是这次调用的子管道', async () => {
    const record = await manager.start({ conversationId: CONV, command: STAY, cwd: root })
    expect(record.status).toBe('running')
    expect(groupAlive(record.pid)).toBe(true)

    const listed = manager.list(CONV)
    expect(listed.map((item) => item.id)).toEqual([record.id])
    expect(listed[0].command).toBe(STAY)

    // stdio 接在文件上,所以等一小会儿就能从日志读到 —— 管道那一支要靠 drain 窗口
    await waitFor(() => manager.logs(CONV, record.id).text.includes('job up'))
  })

  it('命令自己很快结束时 start 就给结论与日志:不把已退出的作业报成运行中', async () => {
    const record = await manager.start({
      conversationId: CONV,
      command: `node -e "console.log('bye')"`,
      cwd: root
    })
    expect(record.status).toBe('exited')
    expect(record.exitCode).toBe(0)
    expect(record.by).toBe('natural')
    expect(manager.logs(CONV, record.id).text).toContain('bye')
  })

  it('日志里读到的是末尾:作业跑久了也不会把几 MB 整份读进来', async () => {
    const record = await manager.start({ conversationId: CONV, command: STAY, cwd: root })
    await waitFor(() => manager.logs(CONV, record.id).text.includes('job up'))
    expect(manager.logs(CONV, record.id, 4).text.length).toBeLessThanOrEqual(4)
  })

  it('别的会话看不到、也读不到这个作业:作业归会话所有', async () => {
    const record = await manager.start({ conversationId: CONV, command: STAY, cwd: root })
    expect(manager.list('conv-2')).toEqual([])
    expect(() => manager.logs('conv-2', record.id)).toThrow(/没有找到/)
    expect(() => manager.logs(CONV, 'job_missing')).toThrow(/没有找到/)
  })

  it('会话没有作业时 list 是空数组:界面据此说「没有后台作业」', () => {
    expect(manager.list(CONV)).toEqual([])
  })
})

describe('停止', () => {
  it('stop 让整个进程组退出,并把结论写成「由你停止」而不是「外部杀死」', async () => {
    const record = await manager.start({ conversationId: CONV, command: STAY, cwd: root })
    const pid = record.pid
    await manager.stop(CONV, record.id)

    expect(record.status).toBe('stopped')
    expect(record.by).toBe('stopped')
    expect(groupAlive(pid)).toBe(false)
    expect(pidAlive(pid)).toBe(false)
  })

  it('stop 收掉命令派生的孙子进程:只杀直接子进程会把服务留在机器上', async () => {
    // 直接子进程活着,同时把一个和它同组的 sleep 拉起来;组杀之后两个都该没了
    const command = `node -e "require('node:child_process').spawn('sleep',['30'],{stdio:'ignore'});setInterval(()=>{},1000)"`
    const record = await manager.start({ conversationId: CONV, command, cwd: root })
    const pid = record.pid
    await manager.stop(CONV, record.id)
    await waitFor(() => !groupAlive(pid))
  })

  it('对已经结束的作业 stop 是幂等的:返回原记录,不改写它的结局', async () => {
    const record = await manager.start({
      conversationId: CONV,
      command: `node -e "process.exit(3)"`,
      cwd: root
    })
    expect(record.status).toBe('exited')
    const again = await manager.stop(CONV, record.id)
    expect(again.by).toBe('natural')
    expect(again.exitCode).toBe(3)
  })

  it('直接子进程自然退出后组里剩下的进程会被收掉:list 是唯一权威,不能有看不见的泄漏', async () => {
    // bash 起一个 sleep 就退出;若不清组,sleep 会留在机器上而作业已经显示「已结束」
    const record = await manager.start({
      conversationId: CONV,
      command: 'sleep 30 &',
      cwd: root
    })
    expect(record.status).toBe('exited')
    await waitFor(() => !groupAlive(record.pid))
  })
})

describe('外部终止', () => {
  it('别人杀掉进程时标成 external:混进超时或中止都会让模型得出错误结论', async () => {
    const record = await manager.start({ conversationId: CONV, command: STAY, cwd: root })
    killGroup(record.pid, 'SIGKILL')
    await waitFor(() => record.status !== 'running')

    expect(record.status).toBe('exited')
    expect(record.by).toBe('external')
    expect(record.signal).toBe('SIGKILL')
  })
})

describe('容量与会话生命周期', () => {
  it('每个会话都有上限:多出来的那一条被拒,且没有真的起进程', async () => {
    for (let i = 0; i < MAX_JOBS_PER_CONVERSATION; i += 1) {
      await manager.start({ conversationId: CONV, command: STAY, cwd: root })
    }
    await expect(manager.start({ conversationId: CONV, command: STAY, cwd: root })).rejects.toThrow(
      /上限/
    )
    expect(manager.list(CONV)).toHaveLength(MAX_JOBS_PER_CONVERSATION)
  }, 30_000)

  it('删会话把它名下的作业一起带走,日志也不留', async () => {
    const record = await manager.start({ conversationId: CONV, command: STAY, cwd: root })
    const pid = record.pid
    const logPath = record.logPath
    manager.dispose(CONV)

    expect(manager.list(CONV)).toEqual([])
    expect(fs.existsSync(logPath)).toBe(false)
    await waitFor(() => !groupAlive(pid))
  })

  it('stopAll 收掉全部作业,并给每条写上「应用退出」', async () => {
    const one = await manager.start({ conversationId: CONV, command: STAY, cwd: root })
    const two = await manager.start({ conversationId: 'conv-2', command: STAY, cwd: root })
    await manager.stopAll()

    expect(one.by).toBe('app-quit')
    expect(two.by).toBe('app-quit')
    expect(one.status).toBe('stopped')
    expect(groupAlive(one.pid)).toBe(false)
  })
})

describe('启动清扫', () => {
  it.skipIf(process.platform === 'win32')(
    '上一次留下的记录对应的进程还活着、启动时刻也对得上时,重启后一并杀掉',
    async () => {
      const previous = await manager.start({ conversationId: CONV, command: STAY, cwd: root })
      expect(groupAlive(previous.pid)).toBe(true)

      // 换一个实例读同一份 index.json,等于重启后的那次清扫
      const restarted = new JobManager({ root })
      restarted.sweep()
      await waitFor(() => !groupAlive(previous.pid))
      expect(restarted.list(CONV)).toEqual([])
    }
  )

  it.skipIf(process.platform === 'win32')(
    '启动时刻对不上时只清记录、不杀进程:pid 被复用时误杀一个无辜进程比漏掉一个孤儿更糟',
    async () => {
      const decoy = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' })
      decoy.unref()
      await waitFor(() => decoy.pid !== undefined)
      expect(decoy.pid).toBeDefined()
      const pid = decoy.pid as number
      try {
        // 记录里的启动时刻写成一小时前:同一 pid 但绝不是当初那个进程
        fs.writeFileSync(
          path.join(root, 'index.json'),
          JSON.stringify([
            {
              id: 'job_stale',
              conversationId: CONV,
              command: 'sleep 30',
              cwd: root,
              pid,
              startedAt: Date.now() - 60 * 60 * 1_000,
              logPath: path.join(root, 'job_stale.log'),
              status: 'running',
              exitCode: null,
              signal: '',
              endedAt: null,
              by: null
            }
          ])
        )
        new JobManager({ root }).sweep()
        expect(pidAlive(pid)).toBe(true)
      } finally {
        killGroup(pid, 'SIGKILL')
      }
    }
  )
})
