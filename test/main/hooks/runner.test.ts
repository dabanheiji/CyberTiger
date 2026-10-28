import fs from 'node:fs'
import path from 'node:path'
import { buildPayload } from '../../../src/main/hooks/contract'
import type { HookTrigger } from '../../../src/main/hooks/contract'
import type { HookBoundary } from '../../../src/main/hooks/boundary'
import { hooksLogPath, recentHooks } from '../../../src/main/hooks/log'
import { DEFAULT_HOOK_TIMEOUT_MS } from '../../../src/main/hooks/parser'
import { runHook } from '../../../src/main/hooks/runner'
import type { HookDisposition, HookRunOptions } from '../../../src/main/hooks/runner'
import type { HookMeta, HookReply } from '../../../src/main/hooks/types'
import type { RunScope } from '../../../src/main/chat/dto'
import { makeTempDir, removeTempDir, writeFiles } from '../../helpers/temp'

/**
 * `runHook` 起的是**真子进程**,所以这里跑的是钩子这一层唯一不能被假 executor 替掉的那一段:
 * argv / stdin / stdout 三根管子的实际形状,加上「一次触发恰好一行日志」。
 *
 * 断言分成三组,各自守一种错法:
 * ① **方向是 fail-open**:命令写错、超时、印一堆非 JSON —— 全部只有一行 `failed` 日志,
 *    而返回的回执 `problem` 非空、`block` 为假,所以**没有任何东西被拦下**。
 *    一个 40 行脚本里的拼写错误不该把用户的一整轮工具调用团住(与审批那道闸门方向相反)。
 * ② **边界是 fail-closed**:声明了 `sandboxed` 而边界建不出来时不起进程,只记一行 `skipped`。
 * ③ **受限那一支真的换了 argv 与 env**:启动器包住的是整条命令,环境是那份白名单而不是 `process.env`。
 */

const NODE = process.execPath
let dir = ''

const SCOPE: RunScope = {
  conversationId: 'conv-1',
  runId: 'run-1',
  agent: '',
  parentCallId: '',
  depth: 0
}

/** 一条最小声明:`command` 是 node 本身、参数是目录里那个脚本,于是 cwd 与相对路径都按钩子目录算 */
function hookMeta(script: string, fields: Partial<HookMeta> = {}): HookMeta {
  writeFiles(dir, { 'hook.cjs': script })
  return {
    name: 'probe',
    description: '探针',
    event: 'beforeToolCall',
    command: NODE,
    args: ['hook.cjs'],
    matcher: [],
    sandboxed: false,
    timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    once: false,
    doc: '',
    dir,
    enabled: true,
    ...fields
  }
}

function trigger(fields: Partial<HookTrigger> = {}): HookTrigger {
  return {
    event: 'beforeToolCall',
    step: 2,
    call: { id: 'call-1', name: 'run_command', arguments: '{"command":"ls"}' },
    args: { command: 'ls' },
    workspaceRelative: '',
    ...fields
  } as HookTrigger
}

function payloadOf(hook: HookMeta, fields: Partial<HookTrigger> = {}) {
  return buildPayload({
    hook,
    scope: SCOPE,
    workspace: dir,
    boundary: 'none',
    request: '列一下目录',
    maxSteps: 10,
    trigger: trigger(fields)
  })
}

const UNRESTRICTED: HookBoundary = {
  mode: 'run',
  launch: undefined,
  boundary: 'none',
  why: '未受限(默认)'
}

/** 与 `set.ts` 同一条处置规则,只是为了让日志那一格的 decision 有真值可断 */
function decide(reply: HookReply): HookDisposition {
  if (reply.block) return { decision: 'blocked' }
  return reply.note === '' ? { decision: 'noop' } : { decision: 'adopted' }
}

function options(extra: Partial<HookRunOptions> = {}): HookRunOptions {
  return { boundary: UNRESTRICTED, signal: new AbortController().signal, apply: decide, ...extra }
}

beforeEach(() => {
  dir = makeTempDir()
  process.env.CYBERTIGER_HOOKS_LOG = path.join(dir, 'hooks.jsonl')
})

afterEach(() => {
  delete process.env.CYBERTIGER_HOOKS_LOG
  removeTempDir(dir)
})

describe('runHook:有结论的那几次', () => {
  it('否决把 block 与 reason 一路带回,日志恰好一行 blocked', async () => {
    const hook = hookMeta(
      `const p = JSON.parse(require('fs').readFileSync(0, 'utf8'))
process.stdout.write(JSON.stringify({ block: true, reason: '挡住 ' + p.data.call.name }))`
    )
    const reply = await runHook(hook, payloadOf(hook), options())
    expect(reply.problem).toBe('')
    expect(reply).toMatchObject({ block: true, reason: '挡住 run_command' })

    const rows = recentHooks()
    // 那份文件走的是环境变量接缝:单测绝不往用户的 userData 里追加日志
    expect(hooksLogPath()).toBe(process.env.CYBERTIGER_HOOKS_LOG)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      decision: 'blocked',
      hook: 'probe',
      event: 'beforeToolCall',
      step: 2,
      reason: '挡住 run_command'
    })
  })

  it('payload 走 stdin 而不是命令行,所以模型写的命令不会出现在 ps 里', async () => {
    const hook = hookMeta(
      `const raw = require('fs').readFileSync(0, 'utf8')
process.stdout.write(JSON.stringify({ note: JSON.parse(raw).data.args.command }))`
    )
    const reply = await runHook(hook, payloadOf(hook), options())
    expect(reply.note).toBe('ls')
  })

  it('退出码非 0 但 stdout 仍是合法回执时照它:失败归失败,否决归否决', async () => {
    const hook = hookMeta(
      `process.stdout.write(JSON.stringify({ block: true, reason: '就是不行' }))
process.exit(3)`
    )
    const reply = await runHook(hook, payloadOf(hook), options())
    // 「退出码表达失败、stdout 表达理由」这条判定表写在 contract.ts,这里钉的是它一路到日志
    expect(reply.block).toBe(true)
    expect(reply.exitCode).toBe(3)
    expect(recentHooks()[0]).toMatchObject({ decision: 'blocked', exit: 3 })
  })

  it('参数不被二次分词:argv 那一支不经过 shell', async () => {
    const hook = hookMeta(
      `process.stdout.write(JSON.stringify({ note: process.argv.slice(2).join('~') }))`,
      { args: ['hook.cjs', '带 空格 的参数', '第二段'] }
    )
    const reply = await runHook(hook, payloadOf(hook), options())
    // 拼进命令串交给 shell 时这里会是 '带~空格~的~参数~第二段':钩子参数里最常写的就是带空格的路径
    expect(reply.note).toBe('带 空格 的参数~第二段')
  })

  it('只进日志的那句(message)进不了模型看到的任何字段,但留在表里', async () => {
    const hook = hookMeta(
      `process.stdout.write(JSON.stringify({ note: '给模型', message: '只给人看' }))`
    )
    const reply = await runHook(hook, payloadOf(hook), options())
    expect(reply).toMatchObject({ note: '给模型', log: '只给人看' })
    expect(recentHooks()[0].log).toBe('只给人看')
  })

  it('不受限那一支继承 process.env:通知类钩子拿得到 HOME 与会话变量', async () => {
    process.env.CYBERTIGER_PROBE = 'yes'
    const hook = hookMeta(
      `process.stdout.write(JSON.stringify({ note: process.env.CYBERTIGER_PROBE || 'no' }))`
    )
    try {
      expect((await runHook(hook, payloadOf(hook), options())).note).toBe('yes')
    } finally {
      delete process.env.CYBERTIGER_PROBE
    }
  })
})

describe('runHook:钩子自己的毛病一律放行', () => {
  it('命令起不来:一行 spawn-error,不抛、也不拦任何东西', async () => {
    // 指向一个不存在的文件而不是「脚本文件写错」:后者 node 会以退出码 1 收场,
    // 那是 bad-output 这一支,只有可执行文件本身找不到才走 spawn-error
    const hook = hookMeta('process.stdout.write("{}")', {
      command: './no-such-binary',
      args: []
    })
    const reply = await runHook(hook, payloadOf(hook), options())
    expect(reply.problem).toContain('命令起不来')
    expect(reply.block).toBe(false)
    expect(recentHooks()[0]).toMatchObject({ decision: 'failed', failure: 'spawn-error' })
    // ENOENT 只在这条路上看得见:界面不会替这行日志说话,所以中文化那句必须落进 err 格
    expect(recentHooks()[0].err).toContain('路径不存在')
  })

  it('睡过超时:有结论、耗时被 timeout 钉住,而不是把整轮挂在管道上', async () => {
    const started = Date.now()
    const hook = hookMeta('setTimeout(() => {}, 5000)', { timeoutMs: 200 })
    const reply = await runHook(hook, payloadOf(hook), options())
    const elapsed = Date.now() - started
    expect(reply.problem).toContain('200')
    expect(reply.block).toBe(false)
    // 200 是那一支的定时器,2500 是 `HARD_STOP_MS` 的硬收场预算:两者之间都算没有结论,
    // 但超过 2500 就是 `runProcess` 的兜底失效了 —— 那会把一整轮悬在这里
    expect(elapsed).toBeLessThan(2_500)
    expect(recentHooks()[0]).toMatchObject({ decision: 'failed', failure: 'timeout' })
  })

  it('中止先于启动:一个进程都不起(marker 不会被写出来)', async () => {
    const controller = new AbortController()
    controller.abort()
    const hook = hookMeta(
      `require('fs').writeFileSync('ran.marker', 'x')
process.stdout.write(JSON.stringify({ block: true, reason: '不该走到这里' }))`
    )
    const reply = await runHook(hook, payloadOf(hook), options({ signal: controller.signal }))
    expect(reply.problem).toContain('本轮已中止')
    expect(fs.existsSync(path.join(dir, 'ran.marker'))).toBe(false)
    expect(recentHooks()[0]).toMatchObject({ decision: 'failed', failure: 'aborted' })
  })

  it('stdout 印的是别的东西:按没有结论处理,原文抄进日志的 out 格', async () => {
    const hook = hookMeta("process.stdout.write('已经处理完了,不用管')")
    const reply = await runHook(hook, payloadOf(hook), options())
    expect(reply.problem).toContain('不是合法的 JSON')
    expect(reply.block).toBe(false)
    expect(recentHooks()[0]).toMatchObject({ decision: 'failed', failure: 'bad-output' })
    // 排查全靠这一格:problem 只说「为什么算失败」,说不出「它到底印了什么」
    expect(recentHooks()[0].out).toContain('已经处理完了')
  })

  it('输出超过上限:整段作废,而不是把半截 JSON 送进判定', async () => {
    const hook = hookMeta(`process.stdout.write(JSON.stringify({ note: 'x'.repeat(200000) }))`)
    const reply = await runHook(hook, payloadOf(hook), options())
    expect(reply.problem).toContain('上限')
    expect(reply.note).toBe('')
    expect(recentHooks()[0].failure).toBe('bad-output')
  })

  it('载荷超过 32 MiB:跳过并写明尺寸,不送进管道', async () => {
    const hook = hookMeta('process.stdout.write("{}")', { event: 'beforeRequest' })
    const payload = payloadOf(hook, {
      event: 'beforeRequest',
      step: 1,
      maxSteps: 10,
      isFinalStep: false,
      tools: ['run_command'],
      messages: [{ role: 'system', content: 'a'.repeat(34 * 1024 * 1024) }]
    })
    const reply = await runHook(hook, payload, options())
    expect(reply.problem).toContain('没有运行')
    expect(reply.block).toBe(false)
    expect(recentHooks()[0]).toMatchObject({ decision: 'skipped', failure: 'payload-too-large' })
  })

  it('处置回调自己抛错:按 failed 收场,照样不拦任何东西', async () => {
    const hook = hookMeta(`process.stdout.write(JSON.stringify({ block: true, reason: '挡住' }))`)
    const reply = await runHook(hook, payloadOf(hook), {
      ...options(),
      apply: () => {
        throw new Error('处置这一层写坏了')
      }
    })
    expect(reply.block).toBe(false)
    expect(reply.problem).toContain('处置这一层写坏了')
    expect(recentHooks()[0]).toMatchObject({ decision: 'failed' })
  })
})

describe('runHook:边界那一侧是 fail-closed', () => {
  it('声明了 sandboxed 而边界建不出来:不起进程,一行 skipped 说清为什么', async () => {
    const hook = hookMeta(
      `require('fs').writeFileSync('ran.marker', 'x')
process.stdout.write('{}')`,
      { sandboxed: true }
    )
    const reply = await runHook(hook, payloadOf(hook), {
      ...options(),
      boundary: { mode: 'skip', why: '这条会话没有选工作空间,因而建不出边界' }
    })
    expect(reply.problem).toContain('没有运行')
    expect(fs.existsSync(path.join(dir, 'ran.marker'))).toBe(false)
    expect(recentHooks()[0]).toMatchObject({
      decision: 'skipped',
      failure: 'no-boundary',
      why: '这条会话没有选工作空间,因而建不出边界'
    })
  })

  it('confined 那一支:启动器包住整条命令,环境用的是它那份白名单而不是 process.env', async () => {
    // 假启动器只回显自己看到的 argv 与环境:于是「argv 被拼在启动器后面」与
    // 「env 是 launch.env 而不是继承来的那一份」都成了可读的断言,而不是注释里的承诺
    process.env.CYBERTIGER_PROBE = 'should-not-leak'
    const hook = hookMeta('process.stdout.write("{}")', { sandboxed: true })
    const echo =
      "process.stdout.write(JSON.stringify({note:[process.execPath === process.argv[1] ? 'wrapped' : 'plain', process.argv.slice(2).join(','), process.env.CYBERTIGER_PROBE || 'no-env', process.env.MARK || ''].join('|')}))"
    try {
      const reply = await runHook(hook, payloadOf(hook), {
        ...options(),
        boundary: {
          mode: 'run',
          launch: { file: NODE, args: ['-e', echo], env: { MARK: 'confined' } },
          boundary: 'confined',
          why: '受限'
        }
      })
      expect(reply.note).toBe('wrapped|hook.cjs|no-env|confined')
    } finally {
      delete process.env.CYBERTIGER_PROBE
    }
  })
})
