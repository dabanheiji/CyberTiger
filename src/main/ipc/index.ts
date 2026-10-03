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
import {
  getStatus as mcpGetStatus,
  saveConfig as mcpSaveConfig,
  reload as mcpReload
} from '../mcp/controller'
import * as skills from '../skills/controller'
import * as agents from '../agents/controller'

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

  ipcMain.handle('skills:list', skills.list)
  ipcMain.handle('skills:setEnabled', skills.setEnabled)
  ipcMain.handle('skills:openDir', skills.openDir)
  ipcMain.handle('skills:discover', skills.discover)
  ipcMain.handle('skills:importLocal', skills.importLocal)
  ipcMain.handle('skills:install', skills.install)
  ipcMain.handle('skills:cancel', skills.cancel)
  ipcMain.handle('skills:uninstall', skills.uninstall)
  ipcMain.handle('skills:update', skills.update)

  ipcMain.handle('agents:list', agents.list)
  ipcMain.handle('agents:setEnabled', agents.setEnabled)
  ipcMain.handle('agents:openDir', agents.openDir)
  ipcMain.handle('agents:listTools', agents.listTools)
  ipcMain.handle('agents:create', agents.create)
  ipcMain.handle('agents:update', agents.update)
  ipcMain.handle('agents:remove', agents.remove)
}
