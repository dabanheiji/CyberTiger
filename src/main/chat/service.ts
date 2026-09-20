import { v4 as uuidv4 } from 'uuid'
import type Database from 'better-sqlite3'
import { getDb } from '../database/index'
import { store } from '../store'
import { chatSql, type Conversation, type Message, type MessageRow } from './sql'
import type {
  createFirstMessageDto,
  sendMessageDto,
  generateReplyDto,
  ChatStreamEvent,
  ToolCallRecord
} from './dto'
import { runAgent, type AgentStore } from '../agent/loop'

interface ActiveRun {
  conversationId: string
  controller: AbortController
}

/** 进行中的 Agent run,key 为 runId */
const activeRuns = new Map<string, ActiveRun>()
/** 应用退出中:不再写库 */
let quitting = false

export function listConversations(): Conversation[] {
  return getDb().prepare<[], Conversation>(chatSql.conversations.list).all()
}

export function createConversation(id: string, title: string): Database.RunResult {
  return getDb().prepare(chatSql.conversations.create).run(id, title)
}

export function renameConversation(id: string, title: string): Database.RunResult {
  return getDb().prepare(chatSql.conversations.rename).run(title, id)
}

export function removeConversation(id: string): Database.RunResult {
  // 该会话若有进行中的 run 先中止,避免删除后继续写库
  for (const run of activeRuns.values()) {
    if (run.conversationId === id) run.controller.abort()
  }
  return getDb().prepare(chatSql.conversations.remove).run(id)
}

export function resortConversation(id: string): Database.RunResult {
  return getDb().prepare(chatSql.conversations.resort).run(id)
}

/** 解析 tool_calls JSON 列;损坏时当作没有 */
function parseToolCalls(raw: string): ToolCallRecord[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as ToolCallRecord[]) : []
  } catch {
    return []
  }
}

export function listMessages(conversationId: string): Message[] {
  return getDb()
    .prepare<[string], MessageRow>(chatSql.messages.list)
    .all(conversationId)
    .map((row) => ({ ...row, tool_calls: parseToolCalls(row.tool_calls) }))
}

export function createMessage(
  messageId: string,
  conversationId: string,
  role: Message['role'],
  content: string
): Database.RunResult {
  return getDb().prepare(chatSql.messages.add).run(messageId, conversationId, role, content)
}

export function removeMessage(id: string): Database.RunResult {
  return getDb().prepare(chatSql.messages.removeById).run(id)
}

export function createFirstMessage(dto: createFirstMessageDto): string {
  const conversationId = uuidv4()
  const messageId = uuidv4()

  const title = dto.content.length > 20 ? dto.content.substring(0, 20) + '...' : dto.content

  const createChat = getDb().transaction(() => {
    createConversation(conversationId, title)
    createMessage(messageId, conversationId, 'user', dto.content)
  })

  createChat()

  return conversationId
}

export function sendMessage(dto: sendMessageDto): string {
  const messageId = uuidv4()

  const appendMessage = getDb().transaction(() => {
    createMessage(messageId, dto.conversationId, 'user', dto.content)
    resortConversation(dto.conversationId)
  })

  appendMessage()

  return messageId
}

/** Agent loop 使用的落库实现;退出中时静默跳过写操作 */
const agentStore: AgentStore = {
  listMessages,
  addStep: (conversationId, runId) => {
    const id = uuidv4()
    getDb().prepare(chatSql.messages.addAssistantStep).run(id, conversationId, runId)
    return id
  },
  updateStep: (messageId, content, reasoning, calls) => {
    if (quitting) return
    getDb()
      .prepare(chatSql.messages.updateStep)
      .run(content, reasoning, JSON.stringify(calls), messageId)
  },
  removeStep: (messageId) => {
    if (quitting) return
    removeMessage(messageId)
  },
  addToolMessage: (conversationId, runId, toolCallId, content) => {
    const id = uuidv4()
    if (quitting) return id
    getDb()
      .prepare(chatSql.messages.addToolMessage)
      .run(id, conversationId, content, toolCallId, runId)
    return id
  },
  touchConversation: (conversationId) => {
    if (quitting) return
    try {
      resortConversation(conversationId)
    } catch (error) {
      console.error('[chat] touch conversation failed:', error)
    }
  }
}

/**
 * 启动一次 Agent run:基于会话历史让模型推理、调用工具、生成最终回复。
 * 同步返回 runId,过程在后台进行,各步事件通过 emit 推送。
 */
export function generateReply(
  dto: generateReplyDto,
  emit: (event: ChatStreamEvent) => void
): string {
  const baseUrl = store.get('baseUrl')
  const apiKey = store.get('apiKey')
  if (!baseUrl) throw new Error('请先在设置中填写 Base URL')
  if (!dto.model) throw new Error('请先选择模型')

  const hasUserMessage = listMessages(dto.conversationId).some((m) => m.role === 'user')
  if (!hasUserMessage) throw new Error('会话不存在或没有可发送的消息')

  const runId = uuidv4()
  const controller = new AbortController()
  activeRuns.set(runId, { conversationId: dto.conversationId, controller })

  void runAgent({
    conversationId: dto.conversationId,
    runId,
    baseUrl,
    apiKey,
    model: dto.model,
    signal: controller.signal,
    store: agentStore,
    emit
  }).finally(() => {
    activeRuns.delete(runId)
  })

  return runId
}

/** 中止指定 run */
export function abortReply(runId: string): void {
  activeRuns.get(runId)?.controller.abort()
}

/** 应用退出时中止全部 run,并停止后续写库 */
export function abortAll(): void {
  quitting = true
  for (const run of activeRuns.values()) run.controller.abort()
}
