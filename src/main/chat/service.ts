import { v4 as uuidv4 } from 'uuid'
import type Database from 'better-sqlite3'
import { getDb } from '../database/index'
import { store } from '../store'
import { chatSql, type Conversation, type Message } from './sql'
import type { createFirstMessageDto, sendMessageDto, generateReplyDto, ChatStreamEvent } from './dto'
import { streamChatCompletion, type ChatCompletionMessage } from './llm'

interface ActiveReply {
  conversationId: string
  controller: AbortController
}

/** 进行中的模型请求,key 为助手消息 id */
const activeReplies = new Map<string, ActiveReply>()
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
  // 该会话若有进行中的模型请求先中止,避免删除后继续写库
  for (const reply of activeReplies.values()) {
    if (reply.conversationId === id) reply.controller.abort()
  }
  return getDb().prepare(chatSql.conversations.remove).run(id)
}

export function resortConversation(id: string): Database.RunResult {
  return getDb().prepare(chatSql.conversations.resort).run(id)
}

export function listMessages(conversationId: string): Message[] {
  return getDb().prepare<[string], Message>(chatSql.messages.list).all(conversationId)
}

export function createMessage(
  messageId: string,
  conversationId: string,
  role: Message['role'],
  content: string
): Database.RunResult {
  return getDb().prepare(chatSql.messages.add).run(messageId, conversationId, role, content)
}

export function updateMessageContent(id: string, content: string): Database.RunResult {
  return getDb().prepare(chatSql.messages.updateContent).run(content, id)
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

/** 插入一条助手消息并返回消息 id;流式生成时先以空内容占位,结束后再更新 */
export function createAssistantMessage(conversationId: string, content: string): string {
  const messageId = uuidv4()
  createMessage(messageId, conversationId, 'assistant', content)
  return messageId
}

/**
 * 基于会话历史调用模型生成回复。
 * 同步返回占位的助手消息 id,生成过程在后台进行,增量与结束状态通过 emit 推送。
 */
export function generateReply(
  dto: generateReplyDto,
  emit: (event: ChatStreamEvent) => void
): string {
  const baseUrl = store.get('baseUrl')
  const apiKey = store.get('apiKey')
  if (!baseUrl) throw new Error('请先在设置中填写 Base URL')
  if (!dto.model) throw new Error('请先选择模型')

  // 本期发送全部历史;后续可按条数或 Token 预算截断
  const history: ChatCompletionMessage[] = listMessages(dto.conversationId)
    .filter((m) => m.content !== '')
    .map((m) => ({ role: m.role, content: m.content }))
  if (history.length === 0) throw new Error('会话不存在或没有可发送的消息')

  const messageId = createAssistantMessage(dto.conversationId, '')
  const controller = new AbortController()
  activeReplies.set(messageId, { conversationId: dto.conversationId, controller })

  void runReply({
    conversationId: dto.conversationId,
    messageId,
    baseUrl,
    apiKey,
    model: dto.model,
    history,
    controller,
    emit
  })

  return messageId
}

/** 中止指定助手消息的生成 */
export function abortReply(messageId: string): void {
  activeReplies.get(messageId)?.controller.abort()
}

/** 应用退出时中止全部请求,并停止后续写库 */
export function abortAll(): void {
  quitting = true
  for (const reply of activeReplies.values()) reply.controller.abort()
}

interface RunReplyParams {
  conversationId: string
  messageId: string
  baseUrl: string
  apiKey?: string
  model: string
  history: ChatCompletionMessage[]
  controller: AbortController
  emit: (event: ChatStreamEvent) => void
}

async function runReply(params: RunReplyParams): Promise<void> {
  const { conversationId, messageId, controller, emit } = params
  let full = ''

  try {
    await streamChatCompletion({
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      model: params.model,
      messages: params.history,
      signal: controller.signal,
      onDelta: (text) => {
        full += text
        emit({ type: 'delta', conversationId, messageId, content: text })
      }
    })
    persistReply(conversationId, messageId, full)
    emit({ type: 'done', conversationId, messageId, aborted: controller.signal.aborted })
  } catch (error) {
    persistReply(conversationId, messageId, full)
    if (controller.signal.aborted) {
      emit({ type: 'done', conversationId, messageId, aborted: true })
    } else {
      const msg = error instanceof Error ? error.message : String(error)
      emit({ type: 'error', conversationId, messageId, msg })
    }
  } finally {
    activeReplies.delete(messageId)
  }
}

/** 有内容则写入占位行并把会话顶到最前;没有任何内容则删掉占位行 */
function persistReply(conversationId: string, messageId: string, content: string): void {
  if (quitting) return
  try {
    if (content) {
      updateMessageContent(messageId, content)
      resortConversation(conversationId)
    } else {
      removeMessage(messageId)
    }
  } catch (error) {
    // 会话已被删除(级联删掉了占位行)等情况下写库失败不影响主流程
    console.error('[chat] persist reply failed:', error)
  }
}
