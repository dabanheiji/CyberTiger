import fs from 'node:fs'
import path from 'node:path'
import { runCommandTool } from '../../../src/main/tools/shell'
import { createToolRunner } from '../../../src/main/tools/registry'
import { makeTempDir, removeTempDir } from '../../helpers/temp'
import type { ToolContext, ToolExecResult } from '../../../src/main/tools/types'

const runner = createToolRunner([runCommandTool])
const ctx: ToolContext = { callId: 'call-1' }

/**
 * 用例都借 `node -e` 发命令:换行、退出码、stderr 在不同 shell 下的写法各不相同,
 * 而这里要验的是工具的行为,不是哪个 shell 更宽容。
 */
const nodeEval = (code: string): string => `node -e ${JSON.stringify(code)}`

function run(args: Record<string, unknown>, context = ctx): Promise<ToolExecResult> {
  return runner.execute('run_command', JSON.stringify(args), context)
}

async function timed(task: Promise<ToolExecResult>): Promise<{ res: ToolExecResult; ms: number }> {
  const start = Date.now()
  const res = await task
  return { res, ms: Date.now() - start }
}

let root = ''

beforeEach(() => {
  root = makeTempDir()
})

afterEach(() => {
  removeTempDir(root)
})

describe('run_command 的结果', () => {
  it('成功命令给出 exit_code、cwd、耗时与输出', async () => {
    const res = await run({ command: nodeEval("console.log('hi')") })
    expect(res.ok).toBe(true)
    expect(res.result).toContain('exit_code: 0')
    expect(res.result).toContain(`cwd: ${process.cwd()}`)
    expect(res.result).toMatch(/耗时: \d+\.\ds/)
    expect(res.result).toContain('输出: 共 1 行 / 3 字符')
    expect(res.result).toContain('hi')
  })

  it('非零退出码不是工具失败:命令自己的错误对模型是有效信息', async () => {
    const res = await run({ command: nodeEval('process.exit(7)') })
    expect(res.ok).toBe(true)
    expect(res.result).toContain('exit_code: 7')
  })

  it('stderr 并进同一条输出并带前缀:分两段会丢掉「哪句错在哪句之后」', async () => {
    const res = await run({
      command: nodeEval("console.log('out');console.error('boom');process.exit(2)")
    })
    expect(res.result).toContain('out')
    expect(res.result).toContain('[stderr] boom')
    expect(res.result).toContain('exit_code: 2')
    // 不再是两个独立小节
    expect(res.result).not.toContain('stdout:')
    expect(res.result).not.toContain('stderr:')
  })

  it('cwd 参数决定命令的工作目录', async () => {
    const res = await run({
      command: nodeEval('console.log(process.cwd())'),
      cwd: root
    })
    expect(res.result).toContain(`cwd: ${root}`)
    expect(res.result).toContain(path.basename(root))
  })

  it('不接参数的 cat 不会拖到超时:stdin 是关闭的,读输入的进程拿不到管道', async () => {
    const res = await run({ command: 'cat', timeout_seconds: 5 })
    expect(res.result).toContain('exit_code: 0')
    expect(res.result).toContain('输出: (无输出)')
  })
})

describe('run_command 的工作空间', () => {
  it('省略 cwd 时就在会话的工作空间里执行:这是"选了目录后命令默认在那儿跑"的兑现', async () => {
    const res = await run(
      { command: nodeEval('console.log(1)') },
      { callId: 'call-ws', workspace: root }
    )
    expect(res.result).toContain(`cwd: ${root}`)
    // 工作空间本身不算越界,不该多出那句提示
    expect(res.result).not.toContain('之外')
  })

  it('相对 cwd 按工作空间解析,而不是应用当前目录', async () => {
    fs.mkdirSync(path.join(root, 'sub/dir'), { recursive: true })
    const res = await run(
      { command: nodeEval('console.log(1)'), cwd: 'sub/dir' },
      { callId: 'call-ws', workspace: root }
    )
    expect(res.result).toContain(`cwd: ${path.join(root, 'sub', 'dir')}`)
  })

  it('显式指定工作空间之外的 cwd 照样执行,并在结果末尾标注:放开作用域但要说清', async () => {
    const outside = makeTempDir()
    try {
      const res = await run(
        { command: nodeEval("console.log('hi')"), cwd: outside },
        { callId: 'call-ws', workspace: root }
      )
      expect(res.ok).toBe(true)
      expect(res.result).toContain(`cwd: ${outside}`)
      expect(res.result).toContain(`在本次会话的工作空间 ${root} 之外`)
    } finally {
      removeTempDir(outside)
    }
  })

  it('没设工作空间时省略 cwd 落在应用当前目录,并且不提工作空间', async () => {
    const res = await run({ command: nodeEval('console.log(1)') })
    expect(res.result).toContain(`cwd: ${process.cwd()}`)
    expect(res.result).not.toContain('工作空间')
  })
})

describe('run_command 的收尾不变量', () => {
  it('命令退出后留下的后台子进程会被一起清掉:前台一条命令只对应一件事', async () => {
    const { res, ms } = await timed(run({ command: 'sleep 5 & echo started', timeout_seconds: 10 }))
    // 不能拖到超时:那意味着这条调用被一个不该留在前台的进程占着
    expect(ms).toBeLessThan(4_000)
    expect(res.result).toContain('started')
    expect(res.result).toContain('已被一并终止')
  })

  it.skipIf(process.platform === 'win32')(
    '孙进程另起会话、逃出进程组攥着管道时也不卡死:观察窗过后主动收场',
    async () => {
      const code = [
        "const { spawn } = require('node:child_process')",
        // detached + inherit:既不在我们的进程组里,又把这条命令的 stdout 攥住;
        // unref 让这一层立刻退出,否则 Node 会自己等着子进程、考不到收尾那一支
        "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1200)'], { detached: true, stdio: 'inherit' }).unref()",
        "console.log('spawned')"
      ].join(';')
      const { res, ms } = await timed(run({ command: nodeEval(code), timeout_seconds: 10 }))
      expect(ms).toBeLessThan(4_000)
      expect(res.result).toContain('spawned')
      expect(res.result).toContain('已被一并终止')
    }
  )

  it.skipIf(process.platform === 'win32')(
    '进程被外部杀掉时说清不是我们发的信号:否则会误报成超时或中止',
    async () => {
      const res = await run({ command: 'kill -9 $$', timeout_seconds: 10 })
      expect(res.result).toContain('本次调用没有发出停止指令')
      expect(res.result).not.toContain('未结束')
      expect(res.result).not.toContain('用户中止')
    }
  )
})

describe('run_command 的边界保护', () => {
  it('超过 timeout_seconds 就终止进程,并仍把已产出的输出交回去', async () => {
    const res = await run({
      command: nodeEval("console.log('half');setTimeout(() => {}, 30_000)"),
      timeout_seconds: 1
    })
    expect(res.result).toContain('超过 1 秒未结束,已被终止')
    expect(res.result).toContain('half')
  })

  it('本轮被中止时杀掉命令:否则用户点了停止,进程还在后台改文件', async () => {
    const controller = new AbortController()
    const pending = run(
      { command: nodeEval('setTimeout(() => {}, 30_000)'), timeout_seconds: 60 },
      { callId: 'call-2', signal: controller.signal }
    )
    setTimeout(() => controller.abort(), 100)
    expect((await pending).result).toContain('用户中止')
  })

  it('输出保头保尾并标明中间省了多少:刷几十万字符会挤掉整段对话', async () => {
    const res = await run({ command: nodeEval("console.log('x'.repeat(40_000))") })
    expect(res.result).toMatch(/\[… 中间 \d+ 字符已省略 …\]/)
    expect(res.result.length).toBeLessThan(20_000)
    // 开头那一段不能整块丢掉:模型要靠它知道这条命令到底输出了什么
    expect(res.result).toContain('---\nxxxx')
  })

  it('工作目录不存在时报「命令无法启动」,不静默退回当前目录', async () => {
    const res = await run({ cwd: path.join(root, 'nope'), command: nodeEval('console.log(1)') })
    expect(res.ok).toBe(false)
    expect(res.result).toContain('命令无法启动')
  })

  it('缺 command 直接拒绝', async () => {
    expect((await run({ command: '  ' })).result).toBe('缺少 command')
  })
})
