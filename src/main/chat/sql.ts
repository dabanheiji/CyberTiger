import type { ToolCallRecord } from './dto'

export interface Conversation {
  id: string
  title: string
  created_at: string
  updated_at: string
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

/** 数据库原始行,tool_calls 是 JSON 字符串 */
export interface MessageRow {
  id: string
  conversation_id: string
  role: MessageRole
  content: string
  reasoning: string
  tool_calls: string
  tool_call_id: string
  run_id: string
  created_at: string
}

/** 对外暴露的消息,tool_calls 已解析 */
export interface Message extends Omit<MessageRow, 'tool_calls'> {
  tool_calls: ToolCallRecord[]
}

export const chatSql = {
  conversations: {
    list: 'SELECT * FROM conversations ORDER BY updated_at DESC',
    create: 'INSERT INTO conversations (id, title) VALUES (?, ?)',
    rename: 'UPDATE conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    remove: 'DELETE FROM conversations WHERE id = ?',
    resort: 'UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  },
  messages: {
    list: 'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC',
    add: 'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
    /** Agent 的一步:空 assistant 行占位 */
    addAssistantStep:
      "INSERT INTO messages (id, conversation_id, role, content, run_id) VALUES (?, ?, 'assistant', '', ?)",
    /** 一步结束后写回正文、思考和工具调用 */
    updateStep: 'UPDATE messages SET content = ?, reasoning = ?, tool_calls = ? WHERE id = ?',
    /** 工具执行结果 */
    addToolMessage:
      "INSERT INTO messages (id, conversation_id, role, content, tool_call_id, run_id) VALUES (?, ?, 'tool', ?, ?, ?)",
    removeById: 'DELETE FROM messages WHERE id = ?',
    removeByConversation: 'DELETE FROM messages WHERE conversation_id = ?'
  }
}
