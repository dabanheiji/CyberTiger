import { ipcMain } from 'electron'
import { get, getAll, set, remove } from '../store/controller'
import {
  sendFirstMessage,
  getAllConversations,
  getMessages,
  sendMessage,
  renameConversation,
  removeConversation,
  generateReply,
  abortReply
} from '../chat/controller'
import { getStatus as mcpGetStatus, saveConfig as mcpSaveConfig, reload as mcpReload } from '../mcp/controller'

export function registerIpc(): void {
  ipcMain.handle('settings:get', get)
  ipcMain.handle('settings:getAll', getAll)
  ipcMain.handle('settings:set', set)
  ipcMain.handle('settings:remove', remove)

  ipcMain.handle('chat:sendFirstMessage', sendFirstMessage)
  ipcMain.handle('chat:getAllConversations', getAllConversations)
  ipcMain.handle('chat:getMessages', getMessages)
  ipcMain.handle('chat:sendMessage', sendMessage)
  ipcMain.handle('chat:renameConversation', renameConversation)
  ipcMain.handle('chat:removeConversation', removeConversation)
  ipcMain.handle('chat:generateReply', generateReply)
  ipcMain.handle('chat:abortReply', abortReply)

  ipcMain.handle('mcp:getStatus', mcpGetStatus)
  ipcMain.handle('mcp:saveConfig', mcpSaveConfig)
  ipcMain.handle('mcp:reload', mcpReload)
}
