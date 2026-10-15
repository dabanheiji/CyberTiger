import type { ToolCallRecord } from './dto'

export interface Conversation {
  id: string
  title: string
  /** 上下文压缩后的摘要正文;空串表示还没压过 */
  summary: string
  /** 摘要覆盖到最后一条消息的 id(水位);空串表示模型仍能看到全部历史 */
  summary_until: string
  /** 上次压缩的账目 JSON(SummaryMetrics);空串表示没有 */
  summary_usage: string
  /** 会话级工作空间目录;空串表示未选择,工具按应用当前目录解析相对路径 */
  workspace: string
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
  /** 本步的输入 token;仅 assistant 行有意义,其余为 0 */
  prompt_tokens: number
  /** 本步的输出 token */
  completion_tokens: number
  /** 1 = 端点没报 usage,上面两个数是本地估算值 */
  tokens_estimated: number
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
    /** 只读摘要三列:构造请求与界面都要用,但不必把整行拉出来 */
    summaryState: 'SELECT summary, summary_until, summary_usage FROM conversations WHERE id = ?',
    /**
     * 写入一次压缩结果。
     * 不动 updated_at —— 压缩不是用户活动,不该把会话顶到列表最前。
     */
    setSummary:
      'UPDATE conversations SET summary = ?, summary_until = ?, summary_usage = ? WHERE id = ?',
    /**
     * 工作空间只有读一列的场合(每次 run 开始时固定一次 cwd),不必拉整行。
     */
    workspace: 'SELECT workspace FROM conversations WHERE id = ?',
    /**
     * 切换会话的工作空间。
     * 与 setSummary 同样不动 updated_at —— 换个目录不是对话活动,不该把会话顶到列表最前。
     */
    setWorkspace: 'UPDATE conversations SET workspace = ? WHERE id = ?',
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
    /**
     * 只取水位之后的顶层行 —— 上下文压缩后发给模型的那段历史。
     * 靠 rowid 比较而不是 created_at:同一秒写入的多行会分不出先后,而 uuid 根本不排序。
     * 水位行的 id 若已不存在(理论上只有手工删库),COALESCE 退成 -1,
     * 等于"没有水位、全量回放" —— 宁可多给内容,也不能悄悄少给。
     */
    listTopLevelAfter:
      "SELECT * FROM messages WHERE conversation_id = ? AND parent_call_id = '' AND rowid > COALESCE((SELECT rowid FROM messages WHERE id = ?), -1) ORDER BY created_at ASC, rowid ASC",
    add: 'INSERT INTO messages (id, conversation_id, role, content, skill) VALUES (?, ?, ?, ?, ?)',
    /** Agent 的一步:空 assistant 行占位 */
    addAssistantStep:
      "INSERT INTO messages (id, conversation_id, role, content, run_id, agent, parent_call_id, depth) VALUES (?, ?, 'assistant', '', ?, ?, ?, ?)",
    /** 一步结束后写回正文、思考、工具调用与本步用量 */
    updateStep:
      'UPDATE messages SET content = ?, reasoning = ?, tool_calls = ?, prompt_tokens = ?, completion_tokens = ?, tokens_estimated = ? WHERE id = ?',
    /** 工具执行结果 */
    addToolMessage:
      "INSERT INTO messages (id, conversation_id, role, content, tool_call_id, run_id, agent, parent_call_id, depth) VALUES (?, ?, 'tool', ?, ?, ?, ?, ?, ?)",
    removeById: 'DELETE FROM messages WHERE id = ?',
    removeByConversation: 'DELETE FROM messages WHERE conversation_id = ?'
  }
}
