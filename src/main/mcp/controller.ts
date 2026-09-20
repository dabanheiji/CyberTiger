import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { store } from '../store'
import type { IpcResult } from '../chat/dto'
import { mcpManager } from './manager'
import { parseMcpConfig } from './config'
import { DEFAULT_MCP_CONFIG, type McpConfig, type McpServerStatus } from './types'

function run<T>(fn: () => T): IpcResult<T> {
  try {
    return { success: true, data: fn() }
  } catch (error) {
    return { success: false, msg: error instanceof Error ? error.message : String(error) }
  }
}

function currentConfig(): McpConfig {
  return store.get('mcpServers') ?? DEFAULT_MCP_CONFIG
}

/** 应用启动时:按存储的配置连接,并把状态变化广播到所有窗口 */
export function initMcp(): void {
  mcpManager.onStatusChange((statuses) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('mcp:status', statuses)
    }
  })
  void mcpManager.reload(currentConfig())
}

export function getStatus(): IpcResult<{ statuses: McpServerStatus[] }> {
  return run(() => ({ statuses: mcpManager.getStatus() }))
}

/** 校验、持久化并按新配置重连 */
export function saveConfig(_e: IpcMainInvokeEvent, json: string): IpcResult<null> {
  return run(() => {
    const config = parseMcpConfig(json)
    store.set('mcpServers', config)
    void mcpManager.reload(config)
    return null
  })
}

export function reload(): IpcResult<null> {
  return run(() => {
    void mcpManager.reconnectAll(currentConfig())
    return null
  })
}
