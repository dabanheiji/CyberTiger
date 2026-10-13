import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Conversation, Message } from '../../main/chat/sql'
import type {
  createFirstMessageDto,
  sendMessageDto,
  renameConversationDto,
  generateReplyDto,
  compactDto,
  ChatStreamEvent,
  CompactReport,
  IpcResult
} from '../../main/chat/dto'

export default {
  sendFirstMessage: (dto: createFirstMessageDto): Promise<IpcResult<{ conversationId: string }>> =>
    ipcRenderer.invoke('chat:sendFirstMessage', dto),
  getAllConversations: (): Promise<IpcResult<{ conversations: Conversation[] }>> =>
    ipcRenderer.invoke('chat:getAllConversations'),
  getMessages: (conversationId: string): Promise<IpcResult<{ messages: Message[] }>> =>
    ipcRenderer.invoke('chat:getMessages', conversationId),
  sendMessage: (dto: sendMessageDto): Promise<IpcResult<{ messageId: string }>> =>
    ipcRenderer.invoke('chat:sendMessage', dto),
  renameConversation: (dto: renameConversationDto): Promise<IpcResult<null>> =>
    ipcRenderer.invoke('chat:renameConversation', dto),
  removeConversation: (conversationId: string): Promise<IpcResult<null>> =>
    ipcRenderer.invoke('chat:removeConversation', conversationId),
  /** 启动一次 Agent run,返回 runId;各步事件通过 onStream 推送 */
  generateReply: (dto: generateReplyDto): Promise<IpcResult<{ runId: string }>> =>
    ipcRenderer.invoke('chat:generateReply', dto),
  abortReply: (runId: string): Promise<IpcResult<null>> =>
    ipcRenderer.invoke('chat:abortReply', runId),
  /**
   * 手动压缩一次会话的上下文。
   * 这是个长耗时调用(压缩自己就是几次模型调用),返回值到手即表示水位已更新。
   */
  compactContext: (dto: compactDto): Promise<IpcResult<CompactReport>> =>
    ipcRenderer.invoke('chat:compactContext', dto),
  /** 订阅流式事件,返回取消订阅函数 */
  onStream: (callback: (event: ChatStreamEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: ChatStreamEvent): void => callback(payload)
    ipcRenderer.on('chat:stream', listener)
    return () => {
      ipcRenderer.removeListener('chat:stream', listener)
    }
  }
}
