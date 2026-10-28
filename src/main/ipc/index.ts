import { ipcMain } from 'electron'
import { get, getAll, set, remove, sandboxStatus } from '../store/controller'
import {
  sendFirstMessage,
  getAllConversations,
  getMessages,
  sendMessage,
  renameConversation,
  removeConversation,
  generateReply,
  abortReply,
  compactContext,
  pickWorkspace,
  setWorkspace,
  answerQuestion,
  decideApproval,
  pendingApprovals
} from '../chat/controller'
import {
  getStatus as mcpGetStatus,
  saveConfig as mcpSaveConfig,
  reload as mcpReload
} from '../mcp/controller'
import * as skills from '../skills/controller'
import * as agents from '../agents/controller'
import * as hooks from '../hooks/controller'
import { report as statsReport } from '../stats/controller'

export function registerIpc(): void {
  ipcMain.handle('settings:get', get)
  ipcMain.handle('settings:getAll', getAll)
  ipcMain.handle('settings:set', set)
  ipcMain.handle('settings:remove', remove)
  // 沙箱的引擎状态不是设置值,是一次探针的结论:同一条 settings:* 例外(返回原始值、不套 IpcResult)
  ipcMain.handle('settings:sandboxStatus', sandboxStatus)

  ipcMain.handle('chat:sendFirstMessage', sendFirstMessage)
  ipcMain.handle('chat:getAllConversations', getAllConversations)
  ipcMain.handle('chat:getMessages', getMessages)
  ipcMain.handle('chat:sendMessage', sendMessage)
  ipcMain.handle('chat:renameConversation', renameConversation)
  ipcMain.handle('chat:removeConversation', removeConversation)
  ipcMain.handle('chat:generateReply', generateReply)
  ipcMain.handle('chat:abortReply', abortReply)
  ipcMain.handle('chat:compactContext', compactContext)
  ipcMain.handle('chat:pickWorkspace', pickWorkspace)
  ipcMain.handle('chat:setWorkspace', setWorkspace)
  ipcMain.handle('chat:answerQuestion', answerQuestion)
  // 审批:交回决定 + 重载后拉回还挂着的卡片
  ipcMain.handle('chat:decideApproval', decideApproval)
  ipcMain.handle('chat:pendingApprovals', pendingApprovals)

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

  // 钩子:声明目录的读写 + 最近执行 + 两个「在系统里打开」
  ipcMain.handle('hooks:list', hooks.list)
  ipcMain.handle('hooks:setEnabled', hooks.setEnabled)
  ipcMain.handle('hooks:create', hooks.create)
  ipcMain.handle('hooks:update', hooks.update)
  ipcMain.handle('hooks:remove', hooks.remove)
  ipcMain.handle('hooks:recent', hooks.recent)
  ipcMain.handle('hooks:openDir', hooks.openDir)
  ipcMain.handle('hooks:openLog', hooks.openLog)

  // 报表:一次区间的 token 用量统计,纯读
  ipcMain.handle('stats:report', statsReport)
}
