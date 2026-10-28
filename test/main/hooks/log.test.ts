import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_RECENT_LINES,
  hooksLogPath,
  recentHooks,
  recordHook
} from '../../../src/main/hooks/log'
import type { HookExecution } from '../../../src/main/hooks/dto'
import { makeTempDir, removeTempDir } from '../../helpers/temp'

/**
 * 「最近执行」那张表的全部数据来源就是这一份 JSONL,所以这里钉的是四件排查时一定会踩的事:
 * 写入不能挡住钩子本身(fail-open)、并发追加不能留半行、超限轮转不能把最新那条转没了、
 * 坏行只能跳过自己而不能把整张表变成空白。
 *
 * 日志里**没有对话正文**是这份文件的口径(`log.ts` 顶部写清了理由),所以这里断的是
 * 「写进去的字段就是 DTO 那一些」,而不是「它会不会过滤掉消息」—— 过滤不在这一层。
 */

let root = ''

function row(overrides: Partial<HookExecution> = {}): HookExecution {
  return {
    ts: new Date().toISOString(),
    event: 'beforeToolCall',
    hook: 'guard',
    conversationId: 'c1',
    runId: 'r1',
    agent: '',
    depth: 0,
    step: 1,
    decision: 'noop',
    ms: 12,
    ...overrides
  }
}

beforeEach(() => {
  root = makeTempDir()
  process.env.CYBERTIGER_HOOKS_LOG = path.join(root, 'logs', 'hooks.jsonl')
})

afterEach(() => {
  delete process.env.CYBERTIGER_HOOKS_LOG
  removeTempDir(root)
})

describe('一次触发一行', () => {
  it('写进去的行原样读回来,新的在前', async () => {
    const first = row({ note: '第一条' })
    await recordHook(first)
    await recordHook(row({ hook: 'notify', note: '第二条' }))
    const rows = recentHooks()
    expect(rows.map((r) => r.note)).toEqual(['第二条', '第一条'])
    // 拿现构造的那一份比,免得 ts 这一格自己跟自己差一毫秒
    expect(rows[1]).toEqual(first)
  })

  it('目录还不存在时自己补上:首次启动一条钩子都没跑过,那份文件本来就没有', async () => {
    expect(fs.existsSync(path.dirname(hooksLogPath()))).toBe(false)
    await recordHook(row())
    expect(fs.existsSync(hooksLogPath())).toBe(true)
  })

  it('还没有这份文件时「最近执行」是空表,不是报错', () => {
    expect(recentHooks()).toEqual([])
  })

  it('skipped 与 failed 那两行的线索字段各自带过去:钩子排障全靠这一格', async () => {
    await recordHook(row({ decision: 'skipped', failure: 'no-boundary', why: '没选工作空间' }))
    await recordHook(
      row({ decision: 'failed', failure: 'bad-output', exit: 3, out: 'not json', err: 'boom' })
    )
    const [failed, skipped] = recentHooks()
    expect(skipped).toMatchObject({
      decision: 'skipped',
      failure: 'no-boundary',
      why: '没选工作空间'
    })
    expect(failed).toMatchObject({
      decision: 'failed',
      failure: 'bad-output',
      exit: 3,
      out: 'not json',
      err: 'boom'
    })
  })

  it('被采纳的改写只留条数:这份文件里不该有整份出站消息', async () => {
    await recordHook(
      row({ event: 'beforeRequest', decision: 'adopted', rewritten: true, msgCount: 9 })
    )
    const [only] = recentHooks()
    expect(only).toMatchObject({ rewritten: true, msgCount: 9 })
    // 写进去的键就是 DTO 的那一些,没有多余的容器可以塞正文
    expect(Object.keys(only).sort()).toEqual(
      [
        'agent',
        'conversationId',
        'decision',
        'depth',
        'event',
        'hook',
        'msgCount',
        'ms',
        'rewritten',
        'runId',
        'step',
        'ts'
      ].sort()
    )
  })
})

describe('写入永不挡住钩子本身', () => {
  it('父目录是个文件时 mkdir 会抛,而 recordHook 只是什么都不写地收场', async () => {
    fs.writeFileSync(path.join(root, 'logs'), '这不是目录', 'utf8')
    process.env.CYBERTIGER_HOOKS_LOG = path.join(root, 'logs', 'hooks.jsonl')
    await expect(recordHook(row())).resolves.toBeUndefined()
    expect(recentHooks()).toEqual([])
  })

  it('日志路径本身被用户建成了目录时同样不 reject:观测面坏了不能让一次工具调用跟着失败', async () => {
    const file = path.join(root, 'logs', 'hooks.jsonl')
    fs.mkdirSync(file, { recursive: true })
    process.env.CYBERTIGER_HOOKS_LOG = file
    await expect(recordHook(row())).resolves.toBeUndefined()
    expect(recentHooks()).toEqual([])
  })
})

describe('并发追加', () => {
  it('几十次同时写也只是一行一条,没有半行', async () => {
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => recordHook(row({ hook: `h${String(i)}` })))
    )
    const text = fs.readFileSync(hooksLogPath(), 'utf8')
    const lines = text.split('\n').filter((l) => l.trim() !== '')
    expect(lines).toHaveLength(40)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
    expect(recentHooks(40)).toHaveLength(40)
  })
})

describe('读取时的宽容与上限', () => {
  it('只取末尾 N 行,新的在前', async () => {
    for (let i = 0; i < 5; i++) await recordHook(row({ hook: `h${String(i)}` }))
    expect(recentHooks(2).map((r) => r.hook)).toEqual(['h4', 'h3'])
  })

  it('缺省上限就是界面上那张表的行数', async () => {
    for (let i = 0; i < DEFAULT_RECENT_LINES + 10; i++) {
      await recordHook(row({ hook: `h${String(i)}` }))
    }
    expect(recentHooks()).toHaveLength(DEFAULT_RECENT_LINES)
  })

  it('脏 limit 退回默认值,而不是把表清空或读无穷多行', async () => {
    for (let i = 0; i < 3; i++) await recordHook(row())
    for (const bad of [0, -1, Number.NaN]) {
      expect(recentHooks(bad)).toHaveLength(3)
    }
  })

  it('坏行只跳过自己:手工编辑过的那一行不能把唯一的失败线索一起带走', async () => {
    await recordHook(row({ hook: 'good' }))
    fs.appendFileSync(hooksLogPath(), '{ 这段不是 JSON\n', 'utf8')
    fs.appendFileSync(hooksLogPath(), '{"ts":"x"}\n', 'utf8')
    await recordHook(row({ hook: 'newer' }))
    expect(recentHooks().map((r) => r.hook)).toEqual(['newer', 'good'])
  })
})

describe('超限轮转', () => {
  it('超过 1 MiB 时只留末尾一千行,而刚写那一条一定还在', async () => {
    const file = hooksLogPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // 造一份已经超限的历史:每行都是合法结论,只是条数堆到了 6000
    const filler = JSON.stringify(row({ hook: 'old', note: 'x'.repeat(160) }))
    fs.writeFileSync(file, `${Array.from({ length: 6000 }, () => filler).join('\n')}\n`, 'utf8')
    expect(fs.statSync(file).size).toBeGreaterThan(1024 * 1024)

    await recordHook(row({ hook: 'fresh' }))
    const lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
    expect(lines).toHaveLength(1000)
    expect(recentHooks(1)[0].hook).toBe('fresh')
    expect(recentHooks(1000).filter((r) => r.hook === 'fresh')).toHaveLength(1)
  })

  it('没超限就不动文件:轮转不是每次写入都重读一遍全文', async () => {
    const file = hooksLogPath()
    await recordHook(row())
    const before = fs.statSync(file)
    await recordHook(row())
    expect(fs.statSync(file).size).toBeGreaterThan(before.size)
    expect(recentHooks()).toHaveLength(2)
  })
})
