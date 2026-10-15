import { DatabaseSync } from 'node:sqlite'
import { columnMigrations, initSql, tableRebuilds } from '../../../src/main/database/sql'
import { runColumnMigrations, runTableRebuilds } from '../../../src/main/database/migrate'
import {
  asMigrationDb,
  columnNames,
  createMemoryDb,
  createSqlOf,
  foreignKeysOn,
  indexNames
} from '../../helpers/sqlite'

/** 老版本库:messages 只有最初五列,CHECK 里还没有 'tool' */
const LEGACY_SCHEMA = `
CREATE TABLE conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '新对话',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  content         TEXT NOT NULL,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);`

let db: DatabaseSync

beforeEach(() => {
  db = createMemoryDb()
})

afterEach(() => {
  db.close()
})

function legacyDb(): DatabaseSync {
  db.exec(LEGACY_SCHEMA)
  return db
}

describe('补列迁移', () => {
  it('老库跑完后补齐全部新增列', () => {
    legacyDb()
    expect(columnNames(db, 'messages')).toEqual([
      'id',
      'conversation_id',
      'role',
      'content',
      'created_at'
    ])
    runColumnMigrations(asMigrationDb(db))
    expect(columnNames(db, 'messages')).toEqual([
      'id',
      'conversation_id',
      'role',
      'content',
      'created_at',
      'reasoning',
      'tool_calls',
      'tool_call_id',
      'run_id',
      'skill',
      'agent',
      'parent_call_id',
      'depth',
      'prompt_tokens',
      'completion_tokens',
      'tokens_estimated'
    ])
  })

  it('老会话表补出摘要三列与工作空间列,旧行读到的是空串而不是 null', () => {
    legacyDb()
    db.prepare("INSERT INTO conversations (id, title) VALUES ('c1', '老会话')").run()
    runColumnMigrations(asMigrationDb(db))
    expect(columnNames(db, 'conversations')).toEqual([
      'id',
      'title',
      'created_at',
      'updated_at',
      'summary',
      'summary_until',
      'summary_usage',
      'workspace'
    ])
    expect(db.prepare('SELECT * FROM conversations').get()).toMatchObject({
      summary: '',
      summary_until: '',
      summary_usage: '',
      // 空串即「没选工作空间」:工具据此退回应用当前目录,与加这列之前一致
      workspace: ''
    })
    // 再跑一次不报错也不重复加列(启动时迁移每次都会跑)
    runColumnMigrations(asMigrationDb(db))
    expect(columnNames(db, 'conversations')).toHaveLength(8)
  })

  it('旧行迁移后读到的是各自列的默认值', () => {
    legacyDb()
    db.prepare("INSERT INTO conversations (id, title) VALUES ('c1', '会话')").run()
    db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content) VALUES ('m1','c1','user','你好')"
    ).run()
    runColumnMigrations(asMigrationDb(db))
    const row = db.prepare('SELECT * FROM messages').get() as Record<string, unknown>
    expect(row.reasoning).toBe('')
    expect(row.tool_calls).toBe('[]')
    expect(row.skill).toBe('')
    expect(row.depth).toBe(0)
  })

  it('重复执行是安全的(已存在的列不再 ALTER)', () => {
    legacyDb()
    const driver = asMigrationDb(db)
    runColumnMigrations(driver)
    const after = columnNames(db, 'messages')
    expect(() => runColumnMigrations(driver)).not.toThrow()
    expect(columnNames(db, 'messages')).toEqual(after)
  })

  it('新库上完全不动', () => {
    db.exec(initSql)
    const before = columnNames(db, 'messages')
    const sqlBefore = createSqlOf(db, 'messages')
    const driver = asMigrationDb(db)
    runColumnMigrations(driver)
    expect(columnNames(db, 'messages')).toEqual(before)
    expect(createSqlOf(db, 'messages')).toBe(sqlBefore)
  })

  it('表还不存在时会报错,说明迁移必须排在建表之后', () => {
    const empty = createMemoryDb()
    expect(() => runColumnMigrations(asMigrationDb(empty))).toThrow()
    empty.close()
  })

  it('给 messages 加的列都带 NOT NULL 与默认值,旧行不会因缺列报错', () => {
    for (const m of columnMigrations.filter((x) => x.table === 'messages')) {
      expect(m.ddl).toMatch(/NOT NULL DEFAULT/)
    }
  })
})

describe('整表重建迁移', () => {
  it('CHECK 里没有 tool 时重建,数据与索引都保住', () => {
    legacyDb()
    db.prepare("INSERT INTO conversations (id, title) VALUES ('c1', '会话')").run()
    db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content) VALUES ('m1','c1','user','你好')"
    ).run()
    runColumnMigrations(asMigrationDb(db))
    runTableRebuilds(asMigrationDb(db))

    expect(createSqlOf(db, 'messages')).toMatch(/'tool'/)
    expect(
      db.prepare("SELECT content FROM messages WHERE id = 'm1'").get() as { content: string }
    ).toEqual({ content: '你好' })
    expect(indexNames(db)).toContain('idx_messages_conversation_created')
    // 重建期间关掉的 foreign_keys 必须恢复,否则 CASCADE 就失效了
    expect(foreignKeysOn(db)).toBe(true)

    expect(() =>
      db
        .prepare(
          "INSERT INTO messages (id, conversation_id, role, content) VALUES ('m2','c1','tool','结果')"
        )
        .run()
    ).not.toThrow()
  })

  it('重建跑第二遍时判定为不需要,建表 SQL 不变', () => {
    legacyDb()
    const driver = asMigrationDb(db)
    runColumnMigrations(driver)
    runTableRebuilds(driver)
    const sqlAfter = createSqlOf(db, 'messages')
    runTableRebuilds(driver)
    expect(createSqlOf(db, 'messages')).toBe(sqlAfter)
  })

  it('新库不需要重建', () => {
    db.exec(initSql)
    const before = createSqlOf(db, 'messages')
    runTableRebuilds(asMigrationDb(db))
    expect(createSqlOf(db, 'messages')).toBe(before)
  })

  it('表不存在时静默跳过', () => {
    const driver = asMigrationDb(db)
    expect(() => runTableRebuilds(driver)).not.toThrow()
    expect(createSqlOf(db, 'messages')).toBeUndefined()
  })

  it('重建中途失败时事务回滚,foreign_keys 仍恢复为开', () => {
    // 故意让旧表缺 skill 列:rebuildSql 的 INSERT ... SELECT 会失败
    db.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '新对话');
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
        content TEXT NOT NULL,
        reasoning TEXT NOT NULL DEFAULT '',
        tool_calls TEXT NOT NULL DEFAULT '[]',
        tool_call_id TEXT NOT NULL DEFAULT '',
        run_id TEXT NOT NULL DEFAULT '',
        agent TEXT NOT NULL DEFAULT '',
        parent_call_id TEXT NOT NULL DEFAULT '',
        depth INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );`)
    db.prepare("INSERT INTO conversations (id, title) VALUES ('c1','会话')").run()
    db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content) VALUES ('m1','c1','user','你好')"
    ).run()

    expect(() => runTableRebuilds(asMigrationDb(db))).toThrow()
    expect(foreignKeysOn(db)).toBe(true)
    // 回滚后旧表和数据都还在,不会出现"表没了"的半截状态
    expect(columnNames(db, 'messages')).toContain('reasoning')
    expect(columnNames(db, 'messages')).not.toContain('skill')
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).toEqual({
      n: 1
    })
    expect(createSqlOf(db, 'messages_new')).toBeUndefined()
  })

  it('needRebuild 只看 CHECK 里有没有 tool', () => {
    const rebuild = tableRebuilds.find((r) => r.table === 'messages')
    expect(rebuild?.needRebuild("CHECK(role IN ('user','assistant','system'))")).toBe(true)
    expect(rebuild?.needRebuild("CHECK(role IN ('user','assistant','system','tool'))")).toBe(false)
  })
})

describe('SCHEMA 与迁移清单的一致性', () => {
  /**
   * 从 initSql 里取出某张表的列名(按声明顺序)。
   * 逐行读到单独的 `);` 为止:注释里也出现 `);`,按字符串 indexOf 找结尾会提前截断。
   */
  function declaredColumns(table: string): string[] {
    const head = `CREATE TABLE IF NOT EXISTS ${table} (`
    const lines = initSql.slice(initSql.indexOf(head) + head.length).split('\n')
    const columns: string[] = []
    for (const line of lines) {
      const text = line.trim()
      if (text === ');') break
      if (text.length === 0 || text.startsWith('--')) continue
      columns.push(text.split(/\s+/)[0].replace(/,/g, ''))
    }
    return columns
  }

  /** 建表时就有的列:它们不需要补列迁移 */
  const baseline: Record<string, string[]> = {
    messages: ['id', 'conversation_id', 'role', 'content', 'created_at'],
    conversations: ['id', 'title', 'created_at', 'updated_at']
  }

  it('除最初几列外,每个列都有对应的补列迁移', () => {
    for (const table of ['messages', 'conversations']) {
      const migrated = columnMigrations
        .filter((m) => m.table === table)
        .map((m) => `${table}.${m.column}`)
      for (const column of declaredColumns(table)) {
        if (baseline[table].includes(column)) continue
        expect(migrated).toContain(`${table}.${column}`)
      }
    }
  })

  it('迁移清单里不存在 initSql 中没有的列', () => {
    for (const m of columnMigrations) {
      expect(declaredColumns(m.table), `${m.table}.${m.column}`).toContain(m.column)
      expect(m.ddl).toContain(`ADD COLUMN ${m.column} `)
    }
  })

  it('重建 SQL 的列清单与新表完全一致', () => {
    const rebuild = tableRebuilds.find((r) => r.table === 'messages')
    const inserted = rebuild?.rebuildSql.match(/INSERT INTO messages_new \(([^)]*)\)/)?.[1]
    expect(inserted?.split(',').map((s) => s.trim())).toEqual(declaredColumns('messages'))
  })
})
