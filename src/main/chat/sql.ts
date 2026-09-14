export interface Conversation {
  id: string
  title: string
  created_at: string
  updated_at: string
}

export interface Message {
  id: string
  conversation_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  created_at: string
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
    updateContent: 'UPDATE messages SET content = ? WHERE id = ?',
    removeById: 'DELETE FROM messages WHERE id = ?',
    removeByConversation: 'DELETE FROM messages WHERE conversation_id = ?'
  }
}
