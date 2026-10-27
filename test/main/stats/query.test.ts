import { DatabaseSync } from 'node:sqlite'
import { initSql } from '../../../src/main/database/sql'
import { statsSql, type UsageRow } from '../../../src/main/stats/sql'
import { aggregateUsage, utcBoundsForRange } from '../../../src/main/stats/aggregate'

/**
 * 与 aggregate.test.ts 同理:这条链要断言的是「筛出来的行落在用户的哪一天」,
 * 时区不钉住就会跟着跑测试的机器变红。
 */
process.env.TZ = 'Asia/Shanghai'

let db: DatabaseSync

beforeEach(() => {
  db = createMemoryDb()
  db.exec(initSql)
  db.prepare("INSERT INTO conversations (id, title) VALUES ('c1', '会话')").run()
})

afterEach(() => {
  db.close()
})

function createMemoryDb(): DatabaseSync {
  const memory = new DatabaseSync(':memory:')
  memory.exec('PRAGMA foreign_keys = ON')
  return memory
}

interface RowSeed {
  id: string
  createdAt: string
  role?: 'user' | 'assistant' | 'tool'
  prompt?: number
  completion?: number
  estimated?: boolean
  providerId?: string
  model?: string
  parentCallId?: string
  depth?: number
}

/** 按报表读的那几列插一行;没写的列一律落在库默认值上 */
function insert(seed: RowSeed): void {
  db.prepare(
    `INSERT INTO messages (
      id, conversation_id, role, content, prompt_tokens, completion_tokens,
      tokens_estimated, model, provider_id, parent_call_id, depth, created_at
     ) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    seed.id,
    'c1',
    seed.role ?? 'assistant',
    seed.prompt ?? 0,
    seed.completion ?? 0,
    seed.estimated ? 1 : 0,
    seed.model ?? 'qwen3.5:4b',
    seed.providerId ?? 'p-1',
    seed.parentCallId ?? '',
    seed.depth ?? 0,
    seed.createdAt
  )
}

function query(from: string, to: string): UsageRow[] {
  const bounds = utcBoundsForRange(from, to)
  return db.prepare(statsSql.usageInRange).all(bounds.start, bounds.end) as unknown as UsageRow[]
}

describe('报表的用量查询', () => {
  it('只取 assistant 行:user 与 tool 行没有模型用量,一并算进来会把调用次数虚增', () => {
    insert({ id: 'a1', createdAt: '2026-10-08 02:00:00', prompt: 100, completion: 20 })
    insert({ id: 'u1', createdAt: '2026-10-08 02:00:01', role: 'user' })
    insert({ id: 't1', createdAt: '2026-10-08 02:00:02', role: 'tool' })
    expect(query('2026-10-08', '2026-10-08').map((r) => r.created_at)).toEqual([
      '2026-10-08 02:00:00'
    ])
  })

  it('子 Agent 的 assistant 行也在结果里:它同样烧 token,排除掉的话总量对不上真实花销', () => {
    insert({ id: 'main', createdAt: '2026-10-08 02:00:00', prompt: 100, completion: 10 })
    insert({
      id: 'sub',
      createdAt: '2026-10-08 03:00:00',
      prompt: 50,
      completion: 5,
      parentCallId: 'call-task',
      depth: 1,
      model: 'deepseek-v3'
    })
    const rows = query('2026-10-08', '2026-10-08')
    expect(rows.map((r) => r.model)).toEqual(['qwen3.5:4b', 'deepseek-v3'])
    expect(aggregateUsage(rows, '2026-10-08', '2026-10-08').totals.steps).toBe(2)
  })

  it('区间边界与日界是同一条换算:首尾两天整点那两行都进来,跨过尾界的那一分钟不算', () => {
    // 2026-10-06 的本地零点是 UTC 2026-10-05 16:00,2026-10-08 结束于 UTC 2026-10-08 16:00
    insert({ id: 'before', createdAt: '2026-10-05 15:59:59', prompt: 9, completion: 9 })
    insert({ id: 'firstSecond', createdAt: '2026-10-05 16:00:00', prompt: 1, completion: 1 })
    insert({ id: 'lastSecond', createdAt: '2026-10-08 15:59:59', prompt: 2, completion: 2 })
    insert({ id: 'after', createdAt: '2026-10-08 16:00:00', prompt: 8, completion: 8 })

    const rows = query('2026-10-06', '2026-10-08')
    expect(rows.map((r) => r.prompt_tokens)).toEqual([1, 2])

    // 筛出来的行分桶之后,合计必须等于筛出来的行之和 —— 出现漏桶就是两套日界漂开了
    const report = aggregateUsage(rows, '2026-10-06', '2026-10-08')
    expect(report.totals.total).toBe(6)
    expect(report.daily.map((d) => d.steps)).toEqual([1, 0, 1])
  })

  it('补零的那几天在中间也照样出现:图上看到的横轴是完整日历,不是「有数据的日子」', () => {
    insert({ id: 'd1', createdAt: '2026-10-06 02:00:00' })
    insert({ id: 'd3', createdAt: '2026-10-08 02:00:00' })
    const report = aggregateUsage(query('2026-10-06', '2026-10-08'), '2026-10-06', '2026-10-08')
    expect(report.daily.map((d) => `${d.day}:${d.steps}`)).toEqual([
      '2026-10-06:1',
      '2026-10-07:0',
      '2026-10-08:1'
    ])
  })

  it('结果按时间升序返回:报表按天分桶不依赖顺序,但趋势图与排障都要按时间读', () => {
    insert({ id: 'later', createdAt: '2026-10-08 09:00:00' })
    insert({ id: 'earlier', createdAt: '2026-10-06 09:00:00' })
    expect(query('2026-10-01', '2026-10-31').map((r) => r.created_at)).toEqual([
      '2026-10-06 09:00:00',
      '2026-10-08 09:00:00'
    ])
  })

  it('这段时间一次都没用过:返回空而不是报错,界面据此显示空态', () => {
    insert({ id: 'a1', createdAt: '2026-10-08 02:00:00' })
    expect(query('2026-09-01', '2026-09-30')).toEqual([])
  })
})
