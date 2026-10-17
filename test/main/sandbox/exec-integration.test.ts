import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCommandTool } from '../../../src/main/tools/shell'
import { createToolRunner } from '../../../src/main/tools/registry'
import { seatbeltProfile, type ExecPolicyInput } from '../../../src/main/sandbox/policy'
import { minimalEnv } from '../../../src/main/sandbox/env'
import type { ExecBoundary } from '../../../src/main/sandbox'
import type { ToolContext } from '../../../src/main/tools/types'
import { makeTempDir, removeTempDir, writeFiles } from '../../helpers/temp'

/**
 * 受限执行的**真实**拦截:在 mac 上真的用 `/usr/bin/sandbox-exec` 起进程。
 *
 * 前面几份用例验的都是文本(`sandbox/policy.test.ts`)与判定(`permission.test.ts`),
 * 而文本对不对只有内核说了算 —— `(deny file-write* (subpath "/tmp"))` 那种静默永不命中的规则、
 * `allow default` 之下还剩下哪些能力、`node -e` 会不会被当成缺权限打死,读 profile 看不出来。
 * 所以这里跑真实载荷,断言的是「拒了且什么都没发生」与「该能跑的照旧能跑」两件事。
 *
 * **绝不碰真实的 `~/.ssh`**:假主目录建在临时根里,清单指向它。
 * 本机引擎起不来时整组跳过而不是失败 —— 这道边界本来就只在 macOS 上有对应机制,
 * 而「跑不起这份文件」和「这台机器没有这个引擎」是两件不同的事。
 */

const SEATBELT_READY = (() => {
  if (process.platform !== 'darwin') return false
  const outcome = spawnSync(
    '/usr/bin/sandbox-exec',
    ['-p', '(version 1)\n(allow default)', '/usr/bin/true'],
    { timeout: 10_000, encoding: 'utf8' }
  )
  return outcome.status === 0
})()

/**
 * mac 的 `os.tmpdir()` 给的是带软链的那一条写法(`/var/folders/…`),真身在 `/private/var/…`。
 * 两者一样的机器上「换写法」那两条没有可验的东西,跳过而不是让它假过。
 */
const HAS_ALT_SPLICING = os.tmpdir() !== fs.realpathSync(os.tmpdir())

/** 三条路径都在同一个临时根之下,但只有工作空间与临时目录进「允许写入」那一档 */
let base = ''
/**
 * 同一条临时根的**另一条写法**(mac 的 `os.tmpdir()` 给 `/var/folders/…`,真身在 `/private/var/…`)。
 * 留着它是为了验下面那条「换写法也读不出」。
 */
let altBase = ''
let workspace = ''
let fakeHome = ''
let scratchTmp = ''

function policyOf(denied: ExecPolicyInput['deniedRead'] = []): ExecPolicyInput {
  return {
    workspace,
    tmpdir: scratchTmp,
    home: fakeHome,
    writableExtra: [],
    allowNetwork: true,
    deniedRead: denied
  }
}

function confinedBoundary(input: ExecPolicyInput): ExecBoundary {
  const launch = {
    file: '/usr/bin/sandbox-exec',
    args: ['-p', seatbeltProfile(input)],
    env: minimalEnv(process.env, input.home, input.tmpdir)
  }
  return { state: 'confined', engine: 'seatbelt', launch, allowNetwork: true }
}

interface RunOptions {
  cwd?: string
  signal?: AbortSignal
  timeoutSeconds?: number
  /** 默认把假主目录的 `.ssh` 点名进清单;只跑读侧无关的那几条时才传空 */
  denied?: ExecPolicyInput['deniedRead']
}

/** 边界装着时的一次执行:真实工具、真实启动器、真实子进程,一个替身都不用 */
async function confined(command: string, options: RunOptions = {}): Promise<string> {
  const boundary = confinedBoundary(
    policyOf(options.denied ?? [{ path: path.join(fakeHome, '.ssh'), directory: true }])
  )
  const context = {
    callId: 'call-1',
    workspace,
    jail: { root: workspace, exec: boundary },
    signal: options.signal
  } satisfies ToolContext
  const args: Record<string, unknown> = { command }
  if (options.cwd) args.cwd = options.cwd
  if (options.timeoutSeconds) args.timeout_seconds = options.timeoutSeconds
  return runCommandTool.execute(args, context)
}

/** 不受限的那一支:`jail` 只有根、没有 `exec`,今天的 `spawn` 语义一字不动 */
async function unconfined(command: string): Promise<string> {
  return runCommandTool.execute({ command }, {
    callId: 'call-2',
    workspace,
    jail: { root: workspace }
  } satisfies ToolContext)
}

function exitCodeOf(result: string): number | null {
  const matched = /^exit_code: (\S+)$/m.exec(result)
  return matched && /^\d+$/.test(matched[1]) ? Number(matched[1]) : null
}

beforeEach(() => {
  const created = makeTempDir()
  altBase = created
  base = fs.realpathSync(created)
  workspace = path.join(base, 'ws')
  fakeHome = path.join(base, 'home')
  scratchTmp = path.join(base, 'tmp')
  writeFiles(fakeHome, { '.ssh/id_ed25519': 'PRIVATE KEY CONTENT', '.ssh/config': 'Host *' })
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(scratchTmp, { recursive: true })
})

afterEach(() => {
  removeTempDir(base)
})

describe.skipIf(!SEATBELT_READY)('受限执行的真实拦截(macOS Seatbelt)', () => {
  it('根内的写入照旧成功:边界不能把自己那个工作区也挡了', async () => {
    const result = await confined(`echo done > ${path.join(workspace, 'inside.txt')}`)
    expect(exitCodeOf(result)).toBe(0)
    expect(fs.readFileSync(path.join(workspace, 'inside.txt'), 'utf8')).toBe('done\n')
    expect(result).toContain('[边界:')
  })

  it('根外的写入被内核挡下,而且**什么都没被创建**:看的是拒了且没执行,不是报错文本好不好看', async () => {
    const target = path.join(base, 'outside.txt')
    const result = await confined(`touch ${target}`)
    expect(exitCodeOf(result)).not.toBe(0)
    expect(fs.existsSync(target)).toBe(false)
    expect(result).toContain('Operation not permitted')
    expect(result).toContain('[注:上述非零退出可能来自这条边界')
  })

  it('清单里点名的凭据目录读不出:这一期正面回答「为什么还能 cat ~/.ssh/id_rsa」', async () => {
    const result = await confined(`cat ${path.join(fakeHome, '.ssh', 'id_ed25519')}`)
    expect(exitCodeOf(result)).not.toBe(0)
    expect(result).not.toContain('PRIVATE KEY CONTENT')
    expect(result).toContain('Operation not permitted')
  })

  /**
   * 点名的凭据目录**换一条写法也读不出**:命中按「被访问路径解出来的真身」判定,
   * 所以清单写真身时两种写法都拦得住,而模型手搓一条带软链的等价路径(`~/../private/var/…`、
   * `/var/…` 之于 `/private/var/…`)绕不过去。
   */
  it.skipIf(!HAS_ALT_SPLICING)(
    '点名的凭据目录换成带软链的写法也读不出:边界认的是真身不是字形',
    async () => {
      const result = await confined(`cat ${path.join(altBase, 'home', '.ssh', 'id_ed25519')}`)
      expect(exitCodeOf(result)).not.toBe(0)
      expect(result).not.toContain('PRIVATE KEY CONTENT')
      expect(result).toContain('Operation not permitted')
    }
  )

  /**
   * 反向的那一半,钉的是接线里 `existingPrivatePaths` 那句 `resolveDeep` 为什么承重:
   * 同一条目录,清单**写成带软链的那一头**就静默永不命中(实测:内核只解被访问的那条路径,
   * 不解规则里写的字符串),文件照读不误 —— 与 `(deny file-write* (subpath "/tmp"))` 挡不住任何东西同一条坑。
   * 这条断言的是「不拦」,所以它红只有一种方式:Seatbelt 改成两种写法都认。那时解真身仍然要做,
   * 因为清单里另一条 `~/.gnupg` 之类要靠真身才能与允许写入的目录比包含关系。
   */
  it.skipIf(!HAS_ALT_SPLICING)(
    '清单不解真身就静默失效:这一条断言的是「读得到」,它是那句 resolveDeep 的存在理由',
    async () => {
      const result = await confined(`cat ${path.join(fakeHome, '.ssh', 'id_ed25519')}`, {
        denied: [{ path: path.join(altBase, 'home', '.ssh'), directory: true }]
      })
      expect(exitCodeOf(result)).toBe(0)
      expect(result).toContain('PRIVATE KEY CONTENT')
    }
  )

  it('清单之外的主目录文件照旧读得到:这一期只点名清单,读侧收敛是另一期的事', async () => {
    writeFiles(fakeHome, { 'notes.txt': 'READABLE' })
    const result = await confined(`cat ${path.join(fakeHome, 'notes.txt')}`)
    expect(exitCodeOf(result)).toBe(0)
    expect(result).toContain('READABLE')
  })

  it('临时目录、PATH 与 /dev/null 都还在:边界只收写侧,不能把建临时目录与 `node -e` 一起打死', async () => {
    const node = await confined('node -e "console.log(1)"')
    expect(exitCodeOf(node)).toBe(0)
    expect(node).toContain('stdout:\n1')

    // 用 `-p "$TMPDIR"` 而不是裸 `mktemp -d`:后者在 mac 上会绕过 `TMPDIR` 去问系统要那一份
    // per-user 临时目录,而这份用例给边界的临时目录是它自己的那一条(生产里两者是同一条,
    // 因为接线传的就是解过真身的 `os.tmpdir()`)。要钉的仍是同一条不变量:env 给的落点
    // 与 profile 放开的必须是同一条字符串,否则「设了 TMPDIR 反而写不了临时文件」。
    const made = await confined('d=$(mktemp -p "$TMPDIR" -d) && echo "$d" && rmdir "$d"')
    expect(exitCodeOf(made)).toBe(0)
    expect(made).toContain(scratchTmp)

    const devNull = await confined('echo x > /dev/null')
    expect(exitCodeOf(devNull)).toBe(0)
  })

  it('环境是白名单:沙箱里看不到父进程的凭据变量,而 HOME 仍是给出去的那一条', async () => {
    process.env.SSH_AUTH_SOCK = path.join(base, 'agent-sock')
    const result = await confined('echo "[${SSH_AUTH_SOCK:-}]"')
    delete process.env.SSH_AUTH_SOCK
    expect(exitCodeOf(result)).toBe(0)
    expect(result).toContain('stdout:\n[]')

    const home = await confined('echo "$HOME"')
    expect(home).toContain(fakeHome)
  })

  it('网络默认放行:这一颗的方向是产品取舍,不是「缺省即最保守」那条纪律', async () => {
    const result = await confined('curl -sS --max-time 5 https://example.com > /dev/null', {
      denied: []
    })
    // 断言的是「没被这道边界挡」,不是「外网通」:离线时 curl 自己会失败,
    // 而那种失败不该让这一条红,所以只要求不出现沙箱给出的那两种网络报错
    expect(result).not.toContain('Network is unreachable')
    expect(result).not.toContain('Temporary failure in name resolution')
  })

  it('受限之下超时与中止仍然杀得掉整个进程组:启动器不换进程组是实测来的,不能只写在注释里', async () => {
    const timed = await confined('sleep 5', { timeoutSeconds: 1 })
    expect(timed).toContain('超过 1 秒未结束')

    const controller = new AbortController()
    const running = confined('sleep 5', { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 300))
    controller.abort()
    expect(await running).toContain('本轮被用户中止')
  })

  it('关掉那一颗子开关(jail 里没有 exec)就回到今天的行为:越界写照旧成功、只带一行标注', async () => {
    const target = path.join(base, 'saved-by-switch.txt')
    const result = await unconfined(`touch ${target}`)
    expect(exitCodeOf(result)).toBe(0)
    expect(fs.existsSync(target)).toBe(true)
    expect(result).not.toContain('[边界:')
  })

  it('引擎装不上时是拒绝而不是降级:那句拒绝由注册表兜成 ok:false,不留孤儿 tool_calls', async () => {
    const runner = createToolRunner([runCommandTool])
    const target = path.join(base, 'never-created.txt')
    const executed = await runner.execute(
      'run_command',
      JSON.stringify({ command: `touch ${target}` }),
      {
        callId: 'call-3',
        workspace,
        jail: { root: workspace, exec: { state: 'unavailable', reason: '本机没有 bubblewrap。' } }
      }
    )
    expect(executed.ok).toBe(false)
    expect(executed.result).toContain('命令没有执行')
    expect(executed.result).toContain('本机没有 bubblewrap。')
    expect(fs.existsSync(target)).toBe(false)
  })

  it('被边界挡下的那两句说明是不含祈使的陈述句:模型会把「请换个写法」当成本轮待办去执行', async () => {
    const result = await confined(`touch ${path.join(base, 'x.txt')}`)
    const note = result.slice(result.indexOf('[边界:'))
    expect(note).not.toMatch(/请|务必|必须|应该|不要|改用|换用/)
  })
})
