import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'path'
import { initSql } from './sql'
import { runColumnMigrations, runTableRebuilds, type MigrationDb } from './migrate'

const DB_PATH = path.join(app.getPath('userData'), 'cybertiger.db')

let db: Database.Database | null = null

/** better-sqlite3 → 迁移所需的最小接口 */
function asMigrationDb(handle: Database.Database): MigrationDb {
  return {
    exec: (sql) => handle.exec(sql),
    pragmaRead: (query) => handle.pragma(query) as Record<string, unknown>[],
    pragmaWrite: (setting) => {
      handle.pragma(setting)
    },
    select: <T>(sql: string, params: unknown[]): T[] => handle.prepare(sql).all(...params) as T[],
    transaction: <T>(fn: () => T): T => handle.transaction(fn)()
  }
}

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH)
    // 开启 WAL 模式，提升并发读写性能
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON') // CASCADE 依赖这个
    db.pragma('busy_timeout = 5000')
    // 建表迁移
    db.exec(initSql)
    const migration = asMigrationDb(db)
    runColumnMigrations(migration)
    runTableRebuilds(migration)
  }
  return db
}

// 应用退出时关闭连接
app.on('before-quit', () => {
  db?.close()
  db = null
})
