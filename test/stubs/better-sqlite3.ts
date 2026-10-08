/**
 * 真实 better-sqlite3 是原生模块,`postinstall` 会把它重建成 Electron ABI,
 * 在 Node 里 require 很可能直接报 NODE_MODULE_VERSION 不匹配。
 * 测试不需要它:SQL 行为与迁移都用 node:sqlite 的内存库验证(见 test/helpers/sqlite.ts)。
 * 这里给一个"被构造就报错"的替身,顺带防止用例误开真实数据库文件。
 */
export default class Database {
  constructor() {
    throw new Error('测试环境不应打开真实的 cybertiger.db')
  }
}
