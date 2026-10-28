import { BufferSink } from '../../../src/main/process/sink'
import { runProcess } from '../../../src/main/process/spawn'
import { makeTempDir, removeTempDir } from '../../helpers/temp'
import type { ExecLaunch } from '../../../src/main/sandbox'
import type { OutputBill, ProcOutcome } from '../../../src/main/process/types'

/**
 * `stdin` / `argv` / 外部 `sink` —— 钩子那条路径要的三个能力。
 *
 * 这里全部跑**真实子进程**(`process.execPath -e`):「EPIPE 有没有打爆进程」「MB 级载荷
 * 是不是真的一次写完」「argv 有没有被 shell 再切一遍」这三件事都没有第二种验法,
 * 换成假进程就只是在断自己的 mock。
 */

/** 把 stdin 原样抄到 stdout:验「写进去的与读出来的逐字节相同」最短的一条路 */
const ECHO_STDIN = 'process.stdin.pipe(process.stdout)'

/** 读完 stdin 只报字节数:MB 级载荷要比的是长度,不能把 3MB 再抄回来当断言 */
const COUNT_STDIN =
  "const c=[];process.stdin.on('data',(d)=>c.push(d));" +
  "process.stdin.on('end',()=>process.stdout.write(String(Buffer.concat(c).length)))"

/** 读到 EOF 就说自己读到了多少:stdin 是关着的时候,这一句立刻成立 */
const REPORT_STDIN =
  "let n=0;process.stdin.on('data',(d)=>{n+=d.length});" +
  "process.stdin.on('end',()=>process.stdout.write('bytes:'+n))"

const IS_WINDOWS = process.platform === 'win32'

let root = ''

beforeEach(() => {
  root = makeTempDir()
})

afterEach(() => {
  removeTempDir(root)
})

interface HookRun {
  outcome: ProcOutcome
  sink: BufferSink
}

/** 钩子那一支的真实形状:argv + BufferSink,`command` 只留给日志与审批看 */
async function runHook(
  argv: string[],
  stdin?: string,
  extra: { launch?: ExecLaunch; timeoutMs?: number } = {}
): Promise<HookRun> {
  const sink = new BufferSink(8 * 1024 * 1024)
  const outcome = await runProcess({
    command: argv.join(' '),
    cwd: root,
    argv,
    stdin,
    sink,
    timeoutMs: 20_000,
    ...extra
  })
  return { outcome, sink }
}

describe('runProcess 的 stdin', () => {
  it('写进 stdin 的载荷被进程原样读到:那是钩子唯一的输入通道,少一个字节就是另一份 JSON', async () => {
    const payload = JSON.stringify({ contract: 1, event: 'beforeAgent' })
    const { outcome, sink } = await runHook([process.execPath, '-e', ECHO_STDIN], payload)
    expect(outcome.code).toBe(0)
    expect(sink.stdout).toBe(payload)
  })

  it('没给 stdin 时那根管照旧是关着的:读输入的进程立刻拿到 EOF,而不是拖到超时', async () => {
    const start = Date.now()
    const { sink } = await runHook([process.execPath, '-e', REPORT_STDIN], undefined)
    // 反向守卫:这一条与 shell.test.ts 里「不接参数的 cat 不会拖到超时」钉的是同一件事 ——
    // 新增的 stdin 能力不能把那条默认纪律改掉,否则每条前台命令都可能挂在一个没人写的管道上
    expect(sink.stdout).toBe('bytes:0')
    expect(Date.now() - start).toBeLessThan(5_000)
  })

  it('stdout 缓冲里只有载荷本身:stderr 另存一处,合流时那句 [stderr] 前缀会把 JSON 弄脏', async () => {
    const code = "console.error('noise');process.stdout.write('{\"ok\":true}')"
    const { sink } = await runHook([process.execPath, '-e', code], '{}')
    expect(sink.stdout).toBe('{"ok":true}')
    expect(sink.stderr).toContain('noise')
    expect(sink.bill().head).toBe('{"ok":true}')
  })

  it('钩子提前退出时那次写入的 EPIPE 不打爆进程:一个钩子的毛病不能变成整个应用崩溃', async () => {
    // 4MB 远超管道容量,所以写入一定会分成好几块;进程在第一块之后就死了,
    // 剩下那些块以 EPIPE 回来。Node 对没接听的 'error' 是抛 uncaughtException ——
    // 那在这里会直接记成测试失败,所以「这条用例过得去」本身就是断言。
    const { outcome } = await runHook(
      [process.execPath, '-e', 'process.exit(0)'],
      'x'.repeat(4_194_304)
    )
    expect(outcome.kind).toBe('exited')
  })

  it('MB 级 stdin 一次性写完且被完整读到:beforeRequest 的真实尺寸,不靠手工分块', async () => {
    const payload = JSON.stringify({
      data: { messages: [{ role: 'user', content: '哈'.repeat(900_000) }] }
    })
    const size = Buffer.byteLength(payload, 'utf8')
    const { outcome, sink } = await runHook([process.execPath, '-e', COUNT_STDIN], payload)
    expect(outcome.code).toBe(0)
    expect(sink.stdout).toBe(String(size))
  })

  it.skipIf(IS_WINDOWS)(
    '攥着 stdout 的孙子进程仍走观察窗:开了 stdin 那根管不能改掉这条收尾不变量',
    async () => {
      const code = [
        "const { spawn } = require('node:child_process')",
        "spawn(process.execPath, ['-e', 'setTimeout(()=>{},1200)'], { detached: true, stdio: 'inherit' }).unref()",
        'process.stdin.resume()',
        "process.stdin.on('end', () => console.log('stdin done'))"
      ].join(';')
      const start = Date.now()
      const { outcome, sink } = await runHook([process.execPath, '-e', code], 'payload')
      // 不能拖到 timeoutMs:那意味着一次钩子调用被一个不该留在前台的进程占着
      expect(Date.now() - start).toBeLessThan(8_000)
      expect(sink.stdout).toContain('stdin done')
      expect(outcome.drained).toBe(true)
    }
  )
})

describe('runProcess 的 argv', () => {
  it('argv 直接交给 spawn:带空格的参数就是原样一项,不被 shell 二次分词', async () => {
    const { sink } = await runHook([
      process.execPath,
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      'a b',
      'c'
    ])
    expect(JSON.parse(sink.stdout)).toEqual(['a b', 'c'])
  })

  it.skipIf(IS_WINDOWS)(
    '有启动器时 argv 接在启动器参数之后:受限那一支是 <启动器> <参数> <程序> <参数> 的 exec 形状',
    async () => {
      // 用 /bin/echo 当假启动器:它把收到的参数逐个字原样打出来,
      // 于是「启动器的参数在前、argv 在后、中间没有 /bin/bash -c」全都看得见。
      const launch: ExecLaunch = { file: '/bin/echo', args: ['MARKER'], env: {} }
      const { sink } = await runHook(['a b', 'c'], undefined, { launch })
      expect(sink.stdout).toBe('MARKER a b c\n')
    }
  )
})

describe('runProcess 的 sink 注入', () => {
  it('省略 sink 时两条流仍合成一条:注入能力不改动前台那条默认路径', async () => {
    const code = "console.log('out');console.error('boom')"
    const outcome = await runProcess({
      command: `${process.execPath} -e ${JSON.stringify(code)}`,
      cwd: root,
      timeoutMs: 20_000
    })
    const bill: OutputBill = outcome.output
    expect(bill.head + bill.tail).toBe('out\n[stderr] boom\n')
  })
})
