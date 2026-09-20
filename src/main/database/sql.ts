export const initSql = `-- 会话表
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '新对话',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 消息表:按 OpenAI 协议逐条存放,一次提问(run)可能产生多条 assistant / tool 行
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
  content         TEXT NOT NULL,
  -- 模型的思考过程(DeepSeek / Ollama 等返回的 reasoning),没有则为空串
  reasoning       TEXT NOT NULL DEFAULT '',
  -- assistant 行发起的工具调用,JSON 数组 ToolCallRecord[]
  tool_calls      TEXT NOT NULL DEFAULT '[]',
  -- tool 行对应的调用 id
  tool_call_id    TEXT NOT NULL DEFAULT '',
  -- 同一次提问产生的所有行共享,供 UI 合并成一个气泡
  run_id          TEXT NOT NULL DEFAULT '',
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 核心索引
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages(conversation_id, created_at);`

/**
 * 增量迁移:按列名判断,旧库缺哪列补哪列。
 * CREATE TABLE IF NOT EXISTS 对已存在的表不生效,新增列必须走这里。
 */
export const columnMigrations: { table: string; column: string; ddl: string }[] = [
  {
    table: 'messages',
    column: 'reasoning',
    ddl: "ALTER TABLE messages ADD COLUMN reasoning TEXT NOT NULL DEFAULT ''"
  },
  {
    table: 'messages',
    column: 'tool_calls',
    ddl: "ALTER TABLE messages ADD COLUMN tool_calls TEXT NOT NULL DEFAULT '[]'"
  },
  {
    table: 'messages',
    column: 'tool_call_id',
    ddl: "ALTER TABLE messages ADD COLUMN tool_call_id TEXT NOT NULL DEFAULT ''"
  },
  {
    table: 'messages',
    column: 'run_id',
    ddl: "ALTER TABLE messages ADD COLUMN run_id TEXT NOT NULL DEFAULT ''"
  }
]

/**
 * 表重建迁移:SQLite 无法修改 CHECK 约束,旧库的 role 不允许 'tool',
 * 需要按"建新表 → 拷数据 → 删旧表 → 改名"重建。
 * needRebuild 拿到 sqlite_master 里的建表 SQL 判断是否需要。
 */
export const tableRebuilds: {
  table: string
  needRebuild: (createSql: string) => boolean
  rebuildSql: string
}[] = [
  {
    table: 'messages',
    needRebuild: (createSql) => !/'tool'/.test(createSql),
    rebuildSql: `
      CREATE TABLE messages_new (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
        content         TEXT NOT NULL,
        reasoning       TEXT NOT NULL DEFAULT '',
        tool_calls      TEXT NOT NULL DEFAULT '[]',
        tool_call_id    TEXT NOT NULL DEFAULT '',
        run_id          TEXT NOT NULL DEFAULT '',
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO messages_new (id, conversation_id, role, content, reasoning, tool_calls, tool_call_id, run_id, created_at)
        SELECT id, conversation_id, role, content, reasoning, tool_calls, tool_call_id, run_id, created_at FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_new RENAME TO messages;
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
        ON messages(conversation_id, created_at);`
  }
]
