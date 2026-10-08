import { columnMigrations, tableRebuilds } from './sql'

/**
 * 迁移只用到五种能力。抽出来之后,同一套迁移脚本既能跑在 better-sqlite3 上,
 * 也能跑在测试用的内存库里 —— 迁移是唯一"写错就毁掉用户数据"的代码,
 * 必须能在真实数据库之外被验证。
 */
export interface MigrationDb {
  /** 执行多语句 SQL */
  exec(sql: string): void
  /** 读取 PRAGMA,如 pragmaRead('table_info(messages)') */
  pragmaRead(query: string): Record<string, unknown>[]
  /** 设置 PRAGMA,如 pragmaWrite('foreign_keys = OFF') */
  pragmaWrite(setting: string): void
  /** 查询;参数化避免拼接 */
  select<T>(sql: string, params: unknown[]): T[]
  /** 在一个事务里执行 */
  transaction<T>(fn: () => T): T
}

/** 对已存在的旧库补齐后续新增的列 */
export function runColumnMigrations(db: MigrationDb): void {
  for (const m of columnMigrations) {
    const columns = db.pragmaRead(`table_info(${m.table})`) as { name: string }[]
    if (!columns.some((c) => c.name === m.column)) {
      db.exec(m.ddl)
    }
  }
}

/** 约束变更需要整表重建;先补列再重建,保证拷数据时列齐全 */
export function runTableRebuilds(db: MigrationDb): void {
  for (const r of tableRebuilds) {
    const row = db.select<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      [r.table]
    )[0]
    if (!row || !r.needRebuild(row.sql)) continue
    // 重建期间关闭外键检查,否则 DROP 旧表会触发级联
    db.pragmaWrite('foreign_keys = OFF')
    try {
      db.transaction(() => db.exec(r.rebuildSql))
    } finally {
      db.pragmaWrite('foreign_keys = ON')
    }
  }
}
