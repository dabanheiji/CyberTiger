import path from 'node:path'
import { createHookSet } from '../../../src/main/hooks/set'
import type { HookRunContext, HookSetDeps, ToolCallTarget } from '../../../src/main/hooks/set'
import type { HookPayload } from '../../../src/main/hooks/contract'
import type { HookBoundary } from '../../../src/main/hooks/boundary'
import type { ExecLaunch } from '../../../src/main/sandbox'
import { DEFAULT_HOOK_TIMEOUT_MS } from '../../../src/main/hooks/parser'
import type { HookEvent, HookMeta, HookReply } from '../../../src/main/hooks/types'
import type { HookDisposition } from '../../../src/main/hooks/runner'
import type { RunScope, ToolCallRecord } from '../../../src/main/chat/dto'
import type { ToolContext } from '../../../src/main/tools/registry'

/**
 * 派发规则的断言处:一次 run 里哪些钩子该为这一刻跑、跑完的东西去哪儿。
 *
 * 全部用**假的执行体**(`HookSetDeps.run`),所以这一份不起任何子进程 —— 要钉的是排序、
 * 短路、matcher、说明缓冲区这四条与进程无关的规则;管道与回执的形状归 `runner.test.ts`。
 * 假执行体照样调 `options.apply`,于是「处置」这一格也是真的。
 */

const DIR = path.join(path.sep, 'hooks', 'demo')
const SCOPE: RunScope = {
  conversationId: 'conv-1',
  runId: 'run-1',
  agent: '',
  parentCallId: '',
  depth: 0
}

function meta(name: string, event: HookEvent, fields: Partial<HookMeta> = {}): HookMeta {
  return {
    name,
    description: `${name} 的说明`,
    event,
    command: 'node',
    args: [],
    matcher: [],
    sandboxed: false,
    timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    once: false,
    doc: '',
    dir: DIR,
    enabled: true,
    ...fields
  }
}

function reply(fields: Partial<HookReply> = {}): HookReply {
  return {
    block: false,
    reason: '',
    note: '',
    rewrite: null,
    log: '',
    ignored: [],
    problem: '',
    exitCode: 0,
    out: '',
    ...fields
  }
}

const CALL: ToolCallRecord = {
  id: 'call-1',
  name: 'run_command',
  arguments: '{"command":"git push --force"}'
}

function target(fields: Partial<ToolCallTarget> = {}): ToolCallTarget {
  return { call: CALL, args: { command: 'git push --force' }, step: 1, ...fields }
}

/** 一次 run 的事实;测试只改需要改的那一两格,所以 jail / sandbox 默认是「没开」 */
function context(fields: Partial<HookRunContext> = {}): HookRunContext {
  return {
    scope: SCOPE,
    workspace: '/proj',
    jail: undefined,
    sandbox: undefined,
    signal: new AbortController().signal,
    request: '把这个分支推上去',
    maxSteps: 10,
    ...fields
  }
}

interface Harness {
  /** 按触发顺序记下的 (钩子名, payload, 边界结论, 处置),断言排序与短路全靠它 */
  fired: Array<{
    hook: string
    payload: HookPayload
    boundary: HookBoundary
    disposition: HookDisposition
  }>
  run: (
    hooks: HookMeta[],
    fields?: Partial<HookRunContext>
  ) => ReturnType<ReturnType<typeof createHookSet>['forRun']>
}

/**
 * 假执行体:记下载荷、按 `replies` 给结论,并照真那份的两条纪律走。
 *
 * ① `apply` 只在回执**有结论**时被调用(`runner.ts` 里 `problem !== ''` 直接落一行 `failed`);
 * ② `boundary.mode === 'skip'` 时一个进程都不起、也不落处置。
 * 于是这里断到的「处置」与生产同源,而 `renderer.test.ts` 那份验的是管道。
 *
 * `replies` 按钩子名给,没写的按「没有结论」处理(`problem` 非空)。
 */
function makeHarness(replies: Record<string, HookReply> = {}): Harness {
  const fired: Harness['fired'] = []
  const deps: HookSetDeps = {
    run: async (hook, payload, options) => {
      if (options.boundary.mode === 'skip') {
        fired.push({
          hook: hook.name,
          payload,
          boundary: options.boundary,
          disposition: { decision: 'skipped', failure: 'no-boundary' }
        })
        return reply({ problem: options.boundary.why, exitCode: null })
      }
      const out = replies[hook.name] ?? reply({ problem: '这一次没有结论', exitCode: null })
      fired.push({
        hook: hook.name,
        payload,
        boundary: options.boundary,
        disposition: out.problem === '' ? options.apply(out) : { decision: 'failed' }
      })
      return out
    }
  }
  return {
    fired,
    run: (hooks, fields) => createHookSet(hooks, deps).forRun(context(fields ?? {}))
  }
}

describe('beforeToolCall 的派发', () => {
  it('同事件的几条按名字串行,第一条否决后第二条不再被问', async () => {
    const h = makeHarness({
      aGuard: reply({ block: true, reason: '这台机器上禁止强推' }),
      zOther: reply({ note: '这条不该被跑' })
    })
    const run = h.run([meta('zOther', 'beforeToolCall'), meta('aGuard', 'beforeToolCall')])
    const veto = await run.toolDeps.beforeToolCall(target())

    expect(veto).toContain('aGuard')
    expect(veto).toContain('这台机器上禁止强推')
    // 声明数组的顺序是反的,所以按名排序是唯一可复现的顺序
    expect(h.fired.map((one) => one.hook)).toEqual(['aGuard'])
    expect(h.fired[0].disposition.decision).toBe('blocked')
  })

  it('否决那句点名钩子、给模型看的是陈述句,不含「请改用 / 务必」这类祈使', async () => {
    const h = makeHarness({ guard: reply({ block: true, reason: '这条命令会覆盖别人的分支' }) })
    const veto = await h.run([meta('guard', 'beforeToolCall')]).toolDeps.beforeToolCall(target())
    expect(veto).toBe('[被钩子 guard 拦下:这条命令会覆盖别人的分支]')
    expect(veto).not.toMatch(/请|务必|记得|应该/)
  })

  it('没否决时给 undefined:那次调用照旧执行,钩子只是追加了一句', async () => {
    const h = makeHarness({ guard: reply({ note: '这个仓库要求先跑测试' }) })
    const run = h.run([meta('guard', 'beforeToolCall')])
    expect(await run.toolDeps.beforeToolCall(target())).toBeUndefined()
    expect(run.takeNotes()).toEqual(['这个仓库要求先跑测试'])
  })

  it('matcher 不命中那次调用的钩子一次都不跑', async () => {
    const h = makeHarness({ onlyWrite: reply({ block: true, reason: '不该拦' }) })
    const veto = await h
      .run([meta('onlyWrite', 'beforeToolCall', { matcher: ['write_file'] })])
      .toolDeps.beforeToolCall(target())
    expect(veto).toBeUndefined()
    expect(h.fired).toHaveLength(0)
  })

  it('matcher 命中工具名以外的那一段时读的是参数值:run_command:git push 那类形状有结论', async () => {
    const h = makeHarness({ guard: reply({ block: true, reason: '这台机器上不许强推' }) })
    const run = h.run([meta('guard', 'beforeToolCall', { matcher: ['run_command:git push'] })])
    // 前面垫一条无害命令:拦截侧「任一分段命中即触发」,否则 `ls; git push` 就是绕过口子
    const veto = await run.toolDeps.beforeToolCall(
      target({
        call: {
          id: 'call-2',
          name: 'run_command',
          arguments: '{"command":"ls; git push --force"}'
        },
        args: { command: 'ls; git push --force' }
      })
    )
    expect(veto).toContain('这台机器上不许强推')
    // 同一条钩子在不匹配的那次调用上不开口
    expect(
      await run.toolDeps.beforeToolCall(
        target({
          call: { id: 'call-3', name: 'run_command', arguments: '{"command":"git status"}' },
          args: { command: 'git status' }
        })
      )
    ).toBeUndefined()
    expect(h.fired.map((one) => one.hook)).toEqual(['guard'])
  })

  it('参数解析不出来的调用照样被看见:args 给 null 而原文仍在 payload 里', async () => {
    const h = makeHarness({ guard: reply({ note: '有一条调用的参数坏了' }) })
    const broken = target({
      call: { id: 'call-3', name: 'run_command', arguments: '{坏' },
      args: null
    })
    expect(
      await h.run([meta('guard', 'beforeToolCall')]).toolDeps.beforeToolCall(broken)
    ).toBeUndefined()
    expect(h.fired[0].payload.data.args).toBeNull()
    expect((h.fired[0].payload.data.call as { arguments: string }).arguments).toBe('{坏')
  })

  it('payload 里带着那一步的步号:钩子要知道「第几步的哪一次调用」', async () => {
    const h = makeHarness({ guard: reply({ note: '记下了' }) })
    await h.run([meta('guard', 'beforeToolCall')]).toolDeps.beforeToolCall(target({ step: 4 }))
    // 步号只在 `run` 那一段:`data` 是事件特有的部分,而步号是六个事件共用的事实
    expect(h.fired[0].payload.run.step).toBe(4)
  })

  it('文件类调用带上相对工作空间的那个路径,钩子的 matcher 之外还能按目录自我收窄', async () => {
    const h = makeHarness({ guard: reply({ note: '记下了' }) })
    await h.run([meta('guard', 'beforeToolCall')]).toolDeps.beforeToolCall(
      target({
        call: { id: 'call-4', name: 'read_file', arguments: '{"path":"notes/todo.md"}' },
        args: { path: 'notes/todo.md' }
      })
    )
    expect(h.fired[0].payload.data.workspaceRelative).toBe(path.join('notes', 'todo.md'))
  })
})

describe('afterToolCall 的派发', () => {
  it('那次调用真的执行过了,所以这一层只攒说明:回执里的否决到不了这里', async () => {
    // `block` 在 `readReply` 那侧就按「这个事件不读」归一掉了(见 contract.test.ts),
    // 所以事后钩子递到派发层的回执永远是 block:false —— 这里断的是派发层没有否决通道
    const h = makeHarness({ watch: reply({ note: '已经跑完了', ignored: ['block'] }) })
    const run = h.run([meta('watch', 'afterToolCall')])
    await expect(
      run.toolDeps.afterToolCall({ ...target(), ok: true, result: '命令已执行', durationMs: 42 })
    ).resolves.toBeUndefined()
    expect(run.takeNotes()).toEqual(['已经跑完了'])
    expect(h.fired[0].disposition.decision).toBe('adopted')
    expect(h.fired[0].payload.data).toMatchObject({
      ok: true,
      result: '命令已执行',
      durationMs: 42
    })
  })

  it('两条事后钩子的说明按名字排,所以进请求的顺序可复现', async () => {
    const h = makeHarness({ a: reply({ note: '第一条' }), z: reply({ note: '第二条' }) })
    const run = h.run([meta('z', 'afterToolCall'), meta('a', 'afterToolCall')])
    await run.toolDeps.afterToolCall({ ...target(), ok: true, result: '好', durationMs: 1 })
    expect(run.takeNotes()).toEqual(['第一条', '第二条'])
  })

  it('一次失败的工具调用也触发:钩子要能盯住「哪里出错了」而不是只盯成功', async () => {
    const h = makeHarness({ watch: reply({ note: '这次失败了' }) })
    await h
      .run([meta('watch', 'afterToolCall')])
      .toolDeps.afterToolCall({ ...target(), ok: false, result: '未知工具', durationMs: 3 })
    expect(h.fired[0].payload.data.ok).toBe(false)
    expect(h.fired[0].payload.data.result).toBe('未知工具')
  })

  it('takeNotes 取完即清:说明只属于紧接着的那一次请求,不会被反复贴', async () => {
    const h = makeHarness({ watch: reply({ note: '一条' }) })
    const run = h.run([meta('watch', 'afterToolCall')])
    await run.toolDeps.afterToolCall({ ...target(), ok: true, result: '好', durationMs: 1 })
    expect(run.takeNotes()).toEqual(['一条'])
    expect(run.takeNotes()).toEqual([])
  })

  it('一步里的说明有上限:第 9 条被丢掉,而丢掉的理由进日志那一格', async () => {
    const nine = Array.from({ length: 9 }, (_, i) => meta(`h${String(i)}`, 'afterToolCall'))
    const h = makeHarness(
      Object.fromEntries(nine.map((one, i) => [one.name, reply({ note: `第 ${String(i)} 条` })]))
    )
    const run = h.run(nine)
    // 一次触发把九条名单走完:上限是「一步之内攒了几条」,不是「调了几次」
    await run.toolDeps.afterToolCall({ ...target(), ok: true, result: '好', durationMs: 1 })
    expect(h.fired).toHaveLength(9)
    // 上限挡在这里而不是界面或 loop:一个碎嘴的钩子不该把裁剪推进缩写档、开始裁真正的工具结果
    expect(run.takeNotes()).toHaveLength(8)
    expect(h.fired[8].disposition).toMatchObject({
      decision: 'noop',
      log: expect.stringContaining('上限')
    })
  })
})

describe('边界结论一路进 payload', () => {
  /** 一份「边界装着」的启动器:与 `run_command` 快照里的那一个比引用 */
  const LAUNCH: ExecLaunch = { file: 'sandbox-exec', args: ['-n', 'x'], env: { PATH: '/bin' } }

  it('声明 sandboxed 且这次快照里有 confined:payload 写 confined,启动器由 runner 那侧用', async () => {
    const h = makeHarness({ guard: reply({ note: '记下了' }) })
    const jail: ToolContext['jail'] = {
      root: '/proj',
      exec: {
        state: 'confined',
        engine: 'seatbelt',
        // 与 run_command 同一个对象:这里断的就是「不重算边界、只翻结论」
        launch: LAUNCH,
        allowNetwork: true
      }
    }
    await h
      .run([meta('guard', 'beforeToolCall', { sandboxed: true })], { jail })
      .toolDeps.beforeToolCall(target())
    expect(h.fired[0].payload.boundary).toBe('confined')
    // 与 run_command 同一个**对象**:启动器不是这一层现造的
    expect(h.fired[0].boundary).toMatchObject({ mode: 'run', why: '受限' })
    expect(h.fired[0].boundary).toHaveProperty('launch', LAUNCH)
    expect(h.fired[0].disposition.decision).toBe('adopted')
  })

  it('声明 sandboxed 而这条会话没选工作空间:边界结论一路传到执行体并被跳过,一次否决也不发', async () => {
    const h = makeHarness({ guard: reply({ block: true, reason: '不该跑' }) })
    const veto = await h
      .run([meta('guard', 'beforeToolCall', { sandboxed: true })], { workspace: '' })
      .toolDeps.beforeToolCall(target())
    // 没跑就没有否决:方向是「宁可不跑,也不不受限地跑」,而不是把这次调用团住
    expect(veto).toBeUndefined()
    expect(h.fired[0].boundary).toMatchObject({
      mode: 'skip',
      why: expect.stringContaining('没有选工作空间')
    })
    expect(h.fired[0].disposition).toMatchObject({ decision: 'skipped', failure: 'no-boundary' })
    // payload 里那一格写 none:此刻确实没有任何边界装着它,而这一行也是给人翻的
    expect(h.fired[0].payload.boundary).toBe('none')
  })

  it('没声明 sandboxed 的钩子在 jail 装着时照旧全权限跑:那颗开关不该顺手管住钩子', async () => {
    const h = makeHarness({ notify: reply({ note: '已发通知' }) })
    const jail: ToolContext['jail'] = {
      root: '/proj',
      exec: {
        state: 'confined',
        engine: 'seatbelt',
        launch: LAUNCH,
        allowNetwork: true
      }
    }
    await h.run([meta('notify', 'beforeToolCall')], { jail }).toolDeps.beforeToolCall(target())
    // 有边界但这条钩子不在里面 —— 与「根本没有边界」(none) 是分开的两档,读日志的人才认得出
    expect(h.fired[0].payload.boundary).toBe('unrestricted')
    expect(h.fired[0].boundary).toMatchObject({ mode: 'run', launch: undefined })
    expect(h.fired[0].disposition.decision).toBe('adopted')
  })
})

describe('payload 的公共那一段', () => {
  it('run 级事实一次 run 内固定:父子 run 用各自的作用域,而目录与步数取自这份快照', async () => {
    const h = makeHarness({ guard: reply({ note: '记下了' }) })
    const run = h.run([meta('guard', 'beforeToolCall')], {
      scope: { ...SCOPE, agent: 'researcher', parentCallId: 'task-1', depth: 1 },
      workspace: '/other',
      maxSteps: 6
    })
    await run.toolDeps.beforeToolCall(target())
    expect(run.takeNotes()).toEqual(['记下了'])
    expect(h.fired[0].payload.run).toMatchObject({
      conversationId: 'conv-1',
      agent: 'researcher',
      depth: 1,
      parentCallId: 'task-1',
      maxSteps: 6
    })
    expect(h.fired[0].payload.workspace).toBe('/other')
  })

  it('本轮要回应的那句话每个事件都带:钩子据此判断该不该开口', async () => {
    const h = makeHarness({ guard: reply({ note: '记下了' }) })
    await h
      .run([meta('guard', 'beforeToolCall')], { request: '把 README 的第一段改短一点' })
      .toolDeps.beforeToolCall(target())
    expect(h.fired[0].payload.request).toBe('把 README 的第一段改短一点')
  })

  it('没有结论的那次触发既不否决也不追加说明,处置按 failed 记', async () => {
    const h = makeHarness()
    const run = h.run([meta('broken', 'beforeToolCall')])
    expect(await run.toolDeps.beforeToolCall(target())).toBeUndefined()
    expect(run.takeNotes()).toEqual([])
    // 起不来、超时、印一堆非 JSON 都落在这一格:日志上说「它跑了但没结论」,而不是「它放行了」
    expect(h.fired[0].disposition.decision).toBe('failed')
  })
})
