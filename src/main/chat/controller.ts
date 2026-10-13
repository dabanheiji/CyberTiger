import type { IpcMainInvokeEvent } from 'electron'
import {
  createFirstMessage,
  listConversations,
  listMessages,
  sendMessage as sendMessageService,
  renameConversation as renameConversationService,
  removeConversation as removeConversationService,
  generateReply as generateReplyService,
  abortReply as abortReplyService,
  compactConversationManually
} from './service'
import type {
  createFirstMessageDto,
  sendMessageDto,
  renameConversationDto,
  generateReplyDto,
  compactDto,
  ChatStreamEvent,
  CompactReport,
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

/**
 * 手动压缩一次会话的上下文。
 *
 * 这是个** awaited** 的 handler:压缩就是几次模型调用,渲染层要等它才能刷新占用环,
 * IPC 返回值天然就是「按钮的 loading 该在哪一刻停」。返回值不套 IpcResult 的既有约定不变,
 * 但 `compacted: false` 不是错误 —— 计划拒绝(省不出空间)也要正常回给界面解释原因。
 */
export async function compactContext(
  _e: IpcMainInvokeEvent,
  dto: compactDto
): Promise<IpcResult<CompactReport>> {
  try {
    return { success: true, data: await compactConversationManually(dto) }
  } catch (error) {
    return { success: false, msg: error instanceof Error ? error.message : String(error) }
  }
}
