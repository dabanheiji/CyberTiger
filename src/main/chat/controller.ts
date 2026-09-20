import type { IpcMainInvokeEvent } from 'electron'
import {
  createFirstMessage,
  listConversations,
  listMessages,
  sendMessage as sendMessageService,
  renameConversation as renameConversationService,
  removeConversation as removeConversationService,
  generateReply as generateReplyService,
  abortReply as abortReplyService
} from './service'
import type {
  createFirstMessageDto,
  sendMessageDto,
  renameConversationDto,
  generateReplyDto,
  ChatStreamEvent,
  IpcResult
} from './dto'
import type { Conversation, Message } from './sql'

/** 统一包装 handler 结果,异常转为 { success: false, msg } */
function run<T>(fn: () => T): IpcResult<T> {
  try {
    return { success: true, data: fn() }
  } catch (error) {
    return { success: false, msg: error instanceof Error ? error.message : String(error) }
  }
}

export function sendFirstMessage(
  _e: IpcMainInvokeEvent,
  dto: createFirstMessageDto
): IpcResult<{ conversationId: string }> {
  return run(() => ({ conversationId: createFirstMessage(dto) }))
}

export function getAllConversations(): IpcResult<{ conversations: Conversation[] }> {
  return run(() => ({ conversations: listConversations() }))
}

export function getMessages(
  _e: IpcMainInvokeEvent,
  conversationId: string
): IpcResult<{ messages: Message[] }> {
  return run(() => ({ messages: listMessages(conversationId) }))
}

export function sendMessage(
  _e: IpcMainInvokeEvent,
  dto: sendMessageDto
): IpcResult<{ messageId: string }> {
  return run(() => ({ messageId: sendMessageService(dto) }))
}

export function renameConversation(
  _e: IpcMainInvokeEvent,
  dto: renameConversationDto
): IpcResult<null> {
  return run(() => {
    renameConversationService(dto.conversationId, dto.title)
    return null
  })
}

export function removeConversation(
  _e: IpcMainInvokeEvent,
  conversationId: string
): IpcResult<null> {
  return run(() => {
    removeConversationService(conversationId)
    return null
  })
}

export function generateReply(
  e: IpcMainInvokeEvent,
  dto: generateReplyDto
): IpcResult<{ runId: string }> {
  const emit = (event: ChatStreamEvent): void => {
    // 窗口已关闭时不再推送,但落库照常完成
    if (!e.sender.isDestroyed()) e.sender.send('chat:stream', event)
  }
  return run(() => ({ runId: generateReplyService(dto, emit) }))
}

export function abortReply(_e: IpcMainInvokeEvent, runId: string): IpcResult<null> {
  return run(() => {
    abortReplyService(runId)
    return null
  })
}
