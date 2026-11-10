import { describe, expect, it } from 'vitest'
import type { TerminalEvent } from '../../../src/main/terminal/dto'
import {
  TERMINAL_FLUSH_CHARS,
  TerminalManager,
  type PtyHandle,
  type ResolvedTerminalCwd,
  type TerminalManagerDeps
} from '../../../src/main/terminal/manager'
import type { ShellSpec } from '../../../src/main/terminal/shell'

const SHELL: ShellSpec = { file: '/bin/zsh', args: ['-l'], env: {} }

interface FakePty {
  handle: PtyHandle
  written: string[]
  resizes: Array<[number, number]>
  killed: number
  emitData(data: string): void
  emitExit(exitCode: number, signal?: number): void
}

function makePty(): FakePty {
  const dataListeners: Array<(data: string) => void> = []
  const exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = []
  const fake: FakePty = {
    written: [],
    resizes: [],
    killed: 0,
    emitData: (data) => dataListeners.forEach((listener) => listener(data)),
    emitExit: (exitCode, signal) =>
      exitListeners.forEach((listener) => listener({ exitCode, signal })),
    handle: {
      write: (data) => fake.written.push(data),
      resize: (cols, rows) => fake.resizes.push([cols, rows]),
      kill: () => {
        fake.killed += 1
      },
      onData: (callback) => dataListeners.push(callback),
      onExit: (callback) => exitListeners.push(callback)
    }
  }
  return fake
}

interface Harness {
  manager: TerminalManager
  ptys: FakePty[]
  events: TerminalEvent[]
  runTimers(): void
  pendingTimers(): number
}

function makeHarness(
  resolveCwd: (conversationId: string | null) => ResolvedTerminalCwd = () => ({
    cwd: '/work/a',
    cwdSource: 'workspace'
  }),
  spawnOverride?: TerminalManagerDeps['spawn']
): Harness {
  const ptys: FakePty[] = []
  const events: TerminalEvent[] = []
  const timers: Array<{ handle: number; callback: () => void }> = []
  let timerId = 0

  const deps: TerminalManagerDeps = {
    resolveCwd,
    shell: () => SHELL,
    spawn:
      spawnOverride ??
      (() => {
        const pty = makePty()
        ptys.push(pty)
        return pty.handle
      }),
    schedule: (callback) => {
      timerId += 1
      timers.push({ handle: timerId, callback })
      return timerId
    },
    cancel: (handle) => {
      const index = timers.findIndex((timer) => timer.handle === handle)
      if (index >= 0) timers.splice(index, 1)
    },
    newId: () => `t${ptys.length + 1}`
  }

  const manager = new TerminalManager(deps)
  manager.onEvent((event) => events.push(event))

  return {
    manager,
    ptys,
    events,
    runTimers: () => {
      const due = timers.splice(0, timers.length)
      due.forEach((timer) => timer.callback())
    },
    pendingTimers: () => timers.length
  }
}

describe('TerminalManager 会话复用', () => {
  it('同一工作目录的两次 ensure 只起一个 shell,不同目录各起一个', () => {
    const dirs: string[] = ['/work/a', '/work/b']
    let cursor = 0
    const harness = makeHarness(() => ({ cwd: dirs[cursor], cwdSource: 'workspace' }))

    const first = harness.manager.ensure({ conversationId: 'c1' })
    const second = harness.manager.ensure({ conversationId: 'c2' })
    expect(second.terminalId).toBe(first.terminalId)
    expect(harness.ptys).toHaveLength(1)

    cursor = 1
    const third = harness.manager.ensure({ conversationId: 'c3' })
    expect(third.terminalId).not.toBe(first.terminalId)
    expect(harness.ptys).toHaveLength(2)
  })

  it('ensure 返回 cwd、来源、shell 名与回放快照', () => {
    const harness = makeHarness(() => ({ cwd: '/work/a', cwdSource: 'default-workspace' }))
    const info = harness.manager.ensure({ conversationId: null })
    expect(info).toMatchObject({
      cwd: '/work/a',
      cwdSource: 'default-workspace',
      shell: 'zsh',
      backlog: '',
      seq: 0
    })
  })

  it('spawn 抛错时 ensure 抛一句中文,并说明组件可能没装好', () => {
    const harness = makeHarness(undefined, () => {
      throw new Error('bind ENOENT')
    })
    expect(() => harness.manager.ensure({ conversationId: null })).toThrow(
      /无法启动终端.*bind ENOENT/
    )
    expect(() => harness.manager.ensure({ conversationId: null })).toThrow(/终端组件可能未正确安装/)
  })
})

describe('TerminalManager 输入与尺寸', () => {
  it('write 与 resize 转发到对应会话,未知 id 静默忽略', () => {
    const harness = makeHarness()
    const info = harness.manager.ensure({ conversationId: null })

    harness.manager.write(info.terminalId, 'ls\r')
    harness.manager.resize(info.terminalId, 120, 40)
    expect(harness.ptys[0].written).toEqual(['ls\r'])
    expect(harness.ptys[0].resizes).toEqual([[120, 40]])

    expect(() => harness.manager.write('nope', 'x')).not.toThrow()
    expect(() => harness.manager.resize('nope', 80, 24)).not.toThrow()
    expect(harness.ptys[0].written).toHaveLength(1)
    expect(harness.ptys[0].resizes).toHaveLength(1)
  })

  it('resize 把列数收进 2–500、行数收进 1–200', () => {
    const harness = makeHarness()
    const info = harness.manager.ensure({ conversationId: null })
    harness.manager.resize(info.terminalId, 0, 0)
    harness.manager.resize(info.terminalId, 9999, 9999)
    expect(harness.ptys[0].resizes).toEqual([
      [2, 1],
      [500, 200]
    ])
  })

  it('起 shell 时把缺省尺寸与夹取后的尺寸传给 spawn', () => {
    const sizes: Array<[number, number]> = []
    let cursor = 0
    const dirs = ['/work/a', '/work/b']
    const harness = makeHarness(
      () => ({ cwd: dirs[cursor++], cwdSource: 'workspace' }),
      (_spec, _cwd, cols, rows) => {
        sizes.push([cols, rows])
        const pty = makePty()
        harness.ptys.push(pty)
        return pty.handle
      }
    )
    harness.manager.ensure({ conversationId: null })
    harness.manager.ensure({ conversationId: null, cols: 1, rows: 9999 })
    expect(sizes).toEqual([
      [80, 24],
      [2, 200]
    ])
  })
})

describe('TerminalManager 输出批量与回放', () => {
  it('12ms 窗口内的多次输出合成一条事件,seq 递增', () => {
    const harness = makeHarness()
    const info = harness.manager.ensure({ conversationId: null })
    const pty = harness.ptys[0]

    pty.emitData('a')
    pty.emitData('b')
    pty.emitData('c')
    expect(harness.events).toEqual([])

    harness.runTimers()
    expect(harness.events).toEqual([
      { type: 'data', terminalId: info.terminalId, seq: 1, data: 'abc' }
    ])

    pty.emitData('d')
    harness.runTimers()
    expect(harness.events[1]).toEqual({
      type: 'data',
      terminalId: info.terminalId,
      seq: 2,
      data: 'd'
    })
  })

  it('攒满 64KB 立即发,不等定时器', () => {
    const harness = makeHarness()
    harness.manager.ensure({ conversationId: null })
    harness.ptys[0].emitData('a'.repeat(TERMINAL_FLUSH_CHARS - 10))
    harness.ptys[0].emitData('b'.repeat(10))
    expect(harness.events).toHaveLength(1)
    expect((harness.events[0] as { data: string }).data).toHaveLength(TERMINAL_FLUSH_CHARS)
  })

  it('ensure 的回放快照带着已刷出的输出与最后一条 seq', () => {
    const harness = makeHarness()
    const info = harness.manager.ensure({ conversationId: null })
    harness.ptys[0].emitData('hello ')
    harness.runTimers()
    harness.ptys[0].emitData('world')
    harness.runTimers()

    const again = harness.manager.ensure({ conversationId: null })
    expect(again.terminalId).toBe(info.terminalId)
    expect(again.backlog).toBe('hello world')
    expect(again.seq).toBe(2)
  })
})

describe('TerminalManager 退出与清理', () => {
  it('进程退出时先刷出剩余输出再发 exit,并把会话移出表', () => {
    const conversation = 'c1'
    const harness = makeHarness(() => ({
      cwd: conversation === 'c1' ? '/work/a' : '/work/b',
      cwdSource: 'workspace'
    }))
    const info = harness.manager.ensure({ conversationId: conversation })
    harness.ptys[0].emitData('tail')
    harness.ptys[0].emitExit(3)

    expect(harness.events).toEqual([
      { type: 'data', terminalId: info.terminalId, seq: 1, data: 'tail' },
      { type: 'exit', terminalId: info.terminalId, code: 3 }
    ])

    // 退出后同一个目录再 ensure 会新建 shell
    harness.manager.ensure({ conversationId: conversation })
    expect(harness.ptys).toHaveLength(2)
  })

  it('退出带信号时把 signal 一并发出', () => {
    const harness = makeHarness()
    const info = harness.manager.ensure({ conversationId: null })
    harness.ptys[0].emitExit(0, 15)
    expect(harness.events).toContainEqual({
      type: 'exit',
      terminalId: info.terminalId,
      code: 0,
      signal: 15
    })
  })

  it('disposeAll 杀掉全部 shell、取消定时器并清空会话', () => {
    const dirs = ['/work/a', '/work/b']
    let cursor = 0
    const harness = makeHarness(() => ({ cwd: dirs[cursor], cwdSource: 'workspace' }))
    harness.manager.ensure({ conversationId: null })
    cursor = 1
    harness.manager.ensure({ conversationId: null })
    harness.ptys[0].emitData('pending')
    expect(harness.pendingTimers()).toBe(1)

    harness.manager.disposeAll()
    expect(harness.ptys.map((pty) => pty.killed)).toEqual([1, 1])
    expect(harness.pendingTimers()).toBe(0)

    // 表清空后 ensure 会重新起 shell
    harness.manager.ensure({ conversationId: null })
    expect(harness.ptys).toHaveLength(3)
  })
})
