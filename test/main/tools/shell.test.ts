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

let root = ''

beforeEach(() => {
  root = makeTempDir()
})

afterEach(() => {
  removeTempDir(root)
})

describe('run_command 的结果', () => {
  it('成功命令给出 exit_code、cwd 与 stdout', async () => {
    const res = await run({ command: nodeEval("console.log('hi')") })
    expect(res.ok).toBe(true)
    expect(res.result).toContain('exit_code: 0')
    expect(res.result).toContain(`cwd: ${process.cwd()}`)
    expect(res.result).toContain('stdout:\nhi')
    expect(res.result).toContain('stderr: (无输出)')
  })

  it('非零退出码不是工具失败:命令自己的错误对模型是有效信息', async () => {
    const res = await run({ command: nodeEval('process.exit(7)') })
    expect(res.ok).toBe(true)
    expect(res.result).toContain('exit_code: 7')
  })

  it('stderr 单独一段,模型能据此判断失败原因', async () => {
    const res = await run({
      command: nodeEval("console.error('boom');process.exit(2)")
    })
    expect(res.result).toContain('stderr:\nboom')
    expect(res.result).toContain('exit_code: 2')
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

  it('输出只留末尾一段并标明省略了多少:一条命令刷几十万字符会挤掉整段对话', async () => {
    const res = await run({ command: nodeEval("console.log('x'.repeat(40_000))") })
    expect(res.result).toMatch(/开头 \d+ 字符已省略/)
    expect(res.result.length).toBeLessThan(20_000)
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
