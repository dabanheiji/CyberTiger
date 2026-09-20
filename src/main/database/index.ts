import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'path'
import { initSql, columnMigrations, tableRebuilds } from './sql'

const DB_PATH = path.join(app.getPath('userData'), 'cybertiger.db')

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH)
    // 开启 WAL 模式，提升并发读写性能
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON') // CASCADE 依赖这个
    db.pragma('busy_timeout = 5000')
    // 建表迁移
    db.exec(initSql)
    runColumnMigrations(db)
    runTableRebuilds(db)
  }
  return db
}

/** 对已存在的旧库补齐后续新增的列 */
function runColumnMigrations(db: Database.Database): void {
  for (const m of columnMigrations) {
    const columns = db.pragma(`table_info(${m.table})`) as { name: string }[]
    if (!columns.some((c) => c.name === m.column)) {
      db.exec(m.ddl)
    }
  }
}

/** 约束变更需要整表重建;先补列再重建,保证拷数据时列齐全 */
function runTableRebuilds(db: Database.Database): void {
  for (const r of tableRebuilds) {
    const row = db
      .prepare<[string], { sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get(r.table)
    if (!row || !r.needRebuild(row.sql)) continue
    // 重建期间关闭外键检查,否则 DROP 旧表会触发级联
    db.pragma('foreign_keys = OFF')
    try {
      db.transaction(() => db.exec(r.rebuildSql))()
    } finally {
      db.pragma('foreign_keys = ON')
    }
  }
}

// 应用退出时关闭连接
app.on('before-quit', () => {
  db?.close()
  db = null
})
