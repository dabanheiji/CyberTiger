import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { initSql } from '../../../src/main/database/sql'
import { chatSql, type MessageRow } from '../../../src/main/chat/sql'
import { parseToolCalls, rowToMessage } from '../../../src/main/chat/service'
import type { RunScope } from '../../../src/main/chat/dto'

let db: DatabaseSync

function openDb(): DatabaseSync {
  const handle = new DatabaseSync(':memory:')
  handle.exec('PRAGMA foreign_keys = ON')
  handle.exec(initSql)
  return handle
}

function addConversation(id: string, title = '会话'): void {
  db.prepare(chatSql.conversations.create).run(id, title)
}

const scope = (overrides: Partial<RunScope> = {}): RunScope => ({
  conversationId: 'c1',
  runId: 'r1',
  agent: '',
  parentCallId: '',
  depth: 0,
  ...overrides
})

/** 按 chatSql 的写入语句落一行 assistant 步骤 */
function addStep(id: string, s: RunScope): void {
  db.prepare(chatSql.messages.addAssistantStep).run(
    id,
    s.conversationId,
    s.runId,
    s.agent,
    s.parentCallId,
    s.depth
  )
}

function addTool(id: string, s: RunScope, toolCallId: string, content: string): void {
  db.prepare(chatSql.messages.addToolMessage).run(
    id,
    s.conversationId,
    content,
    toolCallId,
    s.runId,
    s.agent,
    s.parentCallId,
    s.depth
  )
}

function rows(sql: string, ...params: SQLInputValue[]): MessageRow[] {
  return db.prepare(sql).all(...params) as unknown as MessageRow[]
}

/**
 * 按 chatSql 的写回语句更新一步。
 * 参数顺序必须与 service 的落库实现严格一致 —— 错位会把数字写进文本列。
 */
function updateStep(
  id: string,
  content: string,
  reasoning: string,
  toolCalls: string,
  usage = { prompt: 0, completion: 0, estimated: true }
): void {
  db.prepare(chatSql.messages.updateStep).run(
    content,
    reasoning,
    toolCalls,
    usage.prompt,
    usage.completion,
    usage.estimated ? 1 : 0,
    id
  )
}

beforeEach(() => {
  db = openDb()
})

afterEach(() => {
  db.close()
})

describe('会话表', () => {
  it('create 后按 updated_at 倒序列出', () => {
    addConversation('c1', '第一个')
    addConversation('c2', '第二个')
    db.prepare("UPDATE conversations SET updated_at = '2026-01-01 00:00:00' WHERE id = 'c1'").run()
    db.prepare("UPDATE conversations SET updated_at = '2026-01-02 00:00:00' WHERE id = 'c2'").run()
    expect(db.prepare(chatSql.conversations.list).all()).toMatchObject([
      { id: 'c2', title: '第二个' },
      { id: 'c1', title: '第一个' }
    ])
  })

  it('建表默认标题为「新对话」,create 语句总是显式给标题', () => {
    db.prepare("INSERT INTO conversations (id) VALUES ('c1')").run()
    expect(db.prepare('SELECT title FROM conversations').get()).toEqual({ title: '新对话' })
    db.prepare(chatSql.conversations.create).run('c2', '自定义')
    expect(db.prepare('SELECT title FROM conversations WHERE id = ?').get('c2')).toEqual({
      title: '自定义'
    })
  })

  it('rename 与 resort 都会推后更新时间', () => {
    addConversation('c1')
    db.prepare(chatSql.conversations.rename).run('改名了', 'c1')
    expect(db.prepare('SELECT title FROM conversations').get()).toEqual({ title: '改名了' })
    db.prepare("UPDATE conversations SET updated_at = '2020-01-01 00:00:00'").run()
    db.prepare(chatSql.conversations.resort).run('c1')
    const after = db.prepare('SELECT updated_at FROM conversations').get() as { updated_at: string }
    expect(after.updated_at > '2020-01-01 00:00:00').toBe(true)
  })

  it('删除会话时级联删掉它的全部消息', () => {
    addConversation('c1')
    db.prepare(chatSql.messages.add).run('m1', 'c1', 'user', '你好', '')
    addStep('m2', scope())
    addTool('m3', scope(), 'call-1', '结果')
    addConversation('c2')
    db.prepare(chatSql.messages.add).run('m4', 'c2', 'user', '另一个会话', '')

    db.prepare(chatSql.conversations.remove).run('c1')
    expect(rows(chatSql.messages.list, 'c1')).toEqual([])
    expect(rows(chatSql.messages.list, 'c2').map((r) => r.id)).toEqual(['m4'])
  })

  it('外键打开时不允许写入不存在的会话', () => {
    expect(() => db.prepare(chatSql.messages.add).run('m1', 'ghost', 'user', 'x', '')).toThrow()
  })

  it('role 受 CHECK 约束,未知角色被拒', () => {
    addConversation('c1')
    expect(() => db.prepare(chatSql.messages.add).run('m1', 'c1', 'bogus', 'x', '')).toThrow(
      /CHECK constraint failed/
    )
  })
})

describe('消息表的分层读取', () => {
  /**
   * 一次典型的主 agent + 子 agent run:
   * 顶层 user → 顶层 assistant(task 调用)→ 子 agent 的 assistant 与 tool 行
   * → 顶层 tool 行(task 结果)→ 顶层 assistant 收尾。
   */
  function seedNestedRun(): void {
    addConversation('c1')
    db.prepare(chatSql.messages.add).run('u1', 'c1', 'user', '帮我调研一下', '')
    addStep('a1', scope())
    updateStep(
      'a1',
      '',
      '',
      JSON.stringify([{ id: 'task-1', name: 'task', arguments: '{"prompt":"调研"}' }])
    )
    addStep('sa1', scope({ agent: 'researcher', parentCallId: 'task-1', depth: 1 }))
    updateStep('sa1', '子结论', '子思考', '[]')
    addTool(
      'st1',
      scope({ agent: 'researcher', parentCallId: 'task-1', depth: 1 }),
      'inner-1',
      '内部结果'
    )
    addTool('t1', scope(), 'task-1', '子 Agent 的结论')
    addStep('a2', scope())
    updateStep('a2', '综合结论', '', '[]')
  }

  it('list 给出全部行,含子 agent 的嵌套行', () => {
    seedNestedRun()
    expect(rows(chatSql.messages.list, 'c1').map((r) => r.id)).toEqual([
      'u1',
      'a1',
      'sa1',
      'st1',
      't1',
      'a2'
    ])
  })

  it('listTopLevel 只给顶层行,回放历史里不会出现孤儿 tool 行', () => {
    seedNestedRun()
    expect(rows(chatSql.messages.listTopLevel, 'c1').map((r) => r.id)).toEqual([
      'u1',
      'a1',
      't1',
      'a2'
    ])
  })

  it('顶层行仍带 role 与 tool_call_id 等协议字段', () => {
    seedNestedRun()
    const [tool] = rows(chatSql.messages.listTopLevel, 'c1').filter((r) => r.role === 'tool')
    expect(tool).toMatchObject({
      id: 't1',
      tool_call_id: 'task-1',
      run_id: 'r1',
      depth: 0,
      agent: ''
    })
  })

  it('子 agent 行保留角色名与父级调用 id', () => {
    seedNestedRun()
    expect(rows(chatSql.messages.list, 'c1').filter((r) => r.depth === 1)).toMatchObject([
      { id: 'sa1', agent: 'researcher', parent_call_id: 'task-1' },
      { id: 'st1', agent: 'researcher', parent_call_id: 'task-1' }
    ])
  })

  it('同一会话的不同 run 靠 run_id 区分', () => {
    addConversation('c1')
    addStep('a1', scope({ runId: 'r1' }))
    addStep('a2', scope({ runId: 'r2' }))
    expect(rows(chatSql.messages.list, 'c1').map((r) => r.run_id)).toEqual(['r1', 'r2'])
  })

  it('created_at 相同也按插入顺序返回(rowid 兜底)', () => {
    addConversation('c1')
    // CURRENT_TIMESTAMP 只到秒,同一秒内写入的行必须靠 rowid 定序
    db.prepare(chatSql.messages.add).run('m1', 'c1', 'user', '一', '')
    db.prepare(chatSql.messages.add).run('m2', 'c1', 'user', '二', '')
    db.prepare(chatSql.messages.add).run('m3', 'c1', 'user', '三', '')
    const sameSecond = rows(chatSql.messages.list, 'c1').every(
      (r) => r.created_at === rows(chatSql.messages.list, 'c1')[0].created_at
    )
    expect(sameSecond).toBe(true)
    expect(rows(chatSql.messages.list, 'c1').map((r) => r.content)).toEqual(['一', '二', '三'])
  })

  it('按会话隔离:list 不会串到别的会话', () => {
    addConversation('c1')
    addConversation('c2')
    db.prepare(chatSql.messages.add).run('m1', 'c1', 'user', 'A', '')
    db.prepare(chatSql.messages.add).run('m2', 'c2', 'user', 'B', '')
    expect(rows(chatSql.messages.list, 'c1').map((r) => r.id)).toEqual(['m1'])
  })

  it('removeById 删单行,removeByConversation 删整段', () => {
    addConversation('c1')
    addConversation('c2')
    db.prepare(chatSql.messages.add).run('m1', 'c1', 'user', 'A', '')
    db.prepare(chatSql.messages.add).run('m2', 'c1', 'user', 'B', '')
    db.prepare(chatSql.messages.add).run('m3', 'c2', 'user', 'C', '')

    db.prepare(chatSql.messages.removeById).run('m1')
    expect(rows(chatSql.messages.list, 'c1').map((r) => r.id)).toEqual(['m2'])
    db.prepare(chatSql.messages.removeByConversation).run('c1')
    expect(rows(chatSql.messages.list, 'c1')).toEqual([])
    expect(rows(chatSql.messages.list, 'c2').map((r) => r.id)).toEqual(['m3'])
  })

  it('空 assistant 占位行写回前 content 为空串', () => {
    addConversation('c1')
    addStep('a1', scope())
    expect(rows(chatSql.messages.list, 'c1')[0]).toMatchObject({
      role: 'assistant',
      content: '',
      tool_calls: '[]'
    })
  })

  it('updateStep 只按 id 改内容,不动归属字段', () => {
    addConversation('c1')
    addStep('a1', scope({ agent: 'researcher', parentCallId: 'task-1', depth: 1 }))
    updateStep('a1', '正文', '思考', '[{"id":"1","name":"t","arguments":"{}"}]')
    expect(rows(chatSql.messages.list, 'c1')[0]).toMatchObject({
      content: '正文',
      reasoning: '思考',
      agent: 'researcher',
      depth: 1
    })
  })

  it('updateStep 把用量三列一起写回,估算标记存成 0/1', () => {
    addConversation('c1')
    addStep('a1', scope())
    addStep('a2', scope())
    updateStep('a1', '真实用量', '', '[]', { prompt: 1200, completion: 80, estimated: false })
    updateStep('a2', '估算用量', '', '[]', { prompt: 900, completion: 40, estimated: true })
    const [first, second] = rows(chatSql.messages.list, 'c1')
    expect(first).toMatchObject({
      prompt_tokens: 1200,
      completion_tokens: 80,
      tokens_estimated: 0
    })
    expect(second).toMatchObject({
      prompt_tokens: 900,
      completion_tokens: 40,
      tokens_estimated: 1
    })
  })
})

describe('tool_calls 列的 JSON 往返', () => {
  it('合法数组解析回原结构', () => {
    const calls = [{ id: 'c1', name: 'get_current_time', arguments: '{"tz":"local"}' }]
    expect(parseToolCalls(JSON.stringify(calls))).toEqual(calls)
  })

  it('损坏或非数组的 JSON 都当作没有调用', () => {
    expect(parseToolCalls('{不是 JSON')).toEqual([])
    expect(parseToolCalls('')).toEqual([])
    expect(parseToolCalls('"字符串"')).toEqual([])
    expect(parseToolCalls('{"id":"c1"}')).toEqual([])
    expect(parseToolCalls('null')).toEqual([])
  })

  it('rowToMessage 把行转成对外消息,其余字段原样带出', () => {
    addConversation('c1')
    addStep('a1', scope())
    updateStep(
      'a1',
      '答案',
      '推理',
      JSON.stringify([{ id: 'task-1', name: 'task', arguments: '{}' }]),
      { prompt: 321, completion: 12, estimated: false }
    )
    const message = rowToMessage(rows(chatSql.messages.list, 'c1')[0])
    expect(message).toMatchObject({
      id: 'a1',
      conversation_id: 'c1',
      role: 'assistant',
      content: '答案',
      reasoning: '推理',
      skill: '',
      parent_call_id: '',
      prompt_tokens: 321,
      completion_tokens: 12,
      tokens_estimated: 0
    })
    expect(message.tool_calls).toEqual([{ id: 'task-1', name: 'task', arguments: '{}' }])
  })

  it('历史里的脏行(工具列不是 JSON)不会让整个会话读取失败', () => {
    addConversation('c1')
    addStep('a1', scope())
    db.prepare("UPDATE messages SET tool_calls = '坏了' WHERE id = 'a1'").run()
    updateStep('a1', '答案', '', '坏了')
    const messages = rows(chatSql.messages.listTopLevel, 'c1').map(rowToMessage)
    expect(messages[0].tool_calls).toEqual([])
    expect(messages[0].content).toBe('答案')
  })
})
