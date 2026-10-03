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
  /** user 行:通过 / 触发的 skill 名;空串表示无 */
  skill: string
  /** 产生该行的角色名;空串表示主 agent */
  agent: string
  /** 该行归属的父级工具调用 id;空串表示顶层 */
  parent_call_id: string
  /** 嵌套深度:0 = 主 agent,1 = 子 agent */
  depth: number
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
    /** 整段会话的全部行(含子 agent 的嵌套行),渲染层据此还原嵌套结构 */
    list: 'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC',
    /**
     * 只取顶层行,供 Agent 历史使用。
     * 子 agent 的 assistant / tool 行挂在父级 task 调用下,若一并回放会出现脱离
     * 上下文的孤儿 tool 行(违反 OpenAI 协议),也白白把子 agent 的过程灌回主上下文。
     */
    listTopLevel:
      "SELECT * FROM messages WHERE conversation_id = ? AND parent_call_id = '' ORDER BY created_at ASC, rowid ASC",
    add: 'INSERT INTO messages (id, conversation_id, role, content, skill) VALUES (?, ?, ?, ?, ?)',
    /** Agent 的一步:空 assistant 行占位 */
    addAssistantStep:
      "INSERT INTO messages (id, conversation_id, role, content, run_id, agent, parent_call_id, depth) VALUES (?, ?, 'assistant', '', ?, ?, ?, ?)",
    /** 一步结束后写回正文、思考和工具调用 */
    updateStep: 'UPDATE messages SET content = ?, reasoning = ?, tool_calls = ? WHERE id = ?',
    /** 工具执行结果 */
    addToolMessage:
      "INSERT INTO messages (id, conversation_id, role, content, tool_call_id, run_id, agent, parent_call_id, depth) VALUES (?, ?, 'tool', ?, ?, ?, ?, ?, ?)",
    removeById: 'DELETE FROM messages WHERE id = ?',
    removeByConversation: 'DELETE FROM messages WHERE conversation_id = ?'
  }
}
