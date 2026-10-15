import { BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron'
import {
  createFirstMessage,
  listConversations,
  listMessages,
  sendMessage as sendMessageService,
  renameConversation as renameConversationService,
  removeConversation as removeConversationService,
  generateReply as generateReplyService,
  abortReply as abortReplyService,
  compactConversationManually,
  hasActiveWork,
  setConversationWorkspace
} from './service'
import type {
  createFirstMessageDto,
  sendMessageDto,
  renameConversationDto,
  generateReplyDto,
  compactDto,
  setWorkspaceDto,
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

/** 弹系统对话框选工作空间目录;用户取消时 data 为 null,界面据此什么都不改 */
export async function pickWorkspace(e: IpcMainInvokeEvent): Promise<IpcResult<string | null>> {
  try {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options: Electron.OpenDialogOptions = {
      title: '选择工作空间',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return { success: true, data: null }
    return { success: true, data: result.filePaths[0] }
  } catch (error) {
    return { success: false, msg: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 切换会话的工作空间。
 *
 * 拒掉正在 run 的会话:`startRun` 已把目录固定进那一轮,而工具正在按它解析相对路径 ——
 * 中途改写会让「上一秒的路径」和「下一秒的路径」指向不同目录,父子 run 还会分到两个基准。
 */
export function setWorkspace(_e: IpcMainInvokeEvent, dto: setWorkspaceDto): IpcResult<null> {
  return run(() => {
    if (hasActiveWork(dto.conversationId)) {
      throw new Error('这一轮还在进行中,请等它结束或先点击停止')
    }
    setConversationWorkspace(dto.conversationId, dto.dir)
    return null
  })
}
