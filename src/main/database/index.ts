import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'path'
import { initSql } from './sql'

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
  }
  return db
}

// 应用退出时关闭连接
app.on('before-quit', () => {
  db?.close()
  db = null
})
