import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { MigrationDb } from '../../src/main/database/migrate'

/** 内存库:结构与真实库一致,但不落盘 */
export function createMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

/** node:sqlite 版的迁移驱动,与主进程里的 better-sqlite3 适配等价 */
export function asMigrationDb(db: DatabaseSync): MigrationDb {
  return {
    exec: (sql) => db.exec(sql),
    pragmaRead: (query) => db.prepare(`PRAGMA ${query}`).all() as Record<string, unknown>[],
    pragmaWrite: (setting) => db.exec(`PRAGMA ${setting}`),
    select: <T>(sql: string, params: unknown[]): T[] =>
      db.prepare(sql).all(...(params as SQLInputValue[])) as unknown as T[],
    transaction: <T>(fn: () => T): T => {
      db.exec('BEGIN')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
  }
}

export function foreignKeysOn(db: DatabaseSync): boolean {
  const row = db.prepare('PRAGMA foreign_keys').all()[0] as Record<string, number>
  return Number(row['foreign_keys']) === 1
}

/** 表的列名清单 */
export function columnNames(db: DatabaseSync, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => String((row as Record<string, unknown>)['name']))
}

/** sqlite_master 里的建表 SQL */
export function createSqlOf(db: DatabaseSync, table: string): string | undefined {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined
  return row?.sql
}

/** 所有索引名 */
export function indexNames(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((row) => String((row as Record<string, unknown>)['name']))
}
