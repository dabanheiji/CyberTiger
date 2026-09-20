import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { IpcResult } from '../../main/chat/dto'
import type { McpServerStatus } from '../../main/mcp/types'

export default {
  getStatus: (): Promise<IpcResult<{ statuses: McpServerStatus[] }>> =>
    ipcRenderer.invoke('mcp:getStatus'),
  /** 校验并保存编辑器里的 JSON 文本,成功后主进程按新配置重连 */
  saveConfig: (json: string): Promise<IpcResult<null>> =>
    ipcRenderer.invoke('mcp:saveConfig', json),
  /** 用当前配置重连全部 server */
  reload: (): Promise<IpcResult<null>> => ipcRenderer.invoke('mcp:reload'),
  /** 订阅状态变化,返回取消订阅函数 */
  onStatus: (callback: (statuses: McpServerStatus[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: McpServerStatus[]): void => callback(payload)
    ipcRenderer.on('mcp:status', listener)
    return () => {
      ipcRenderer.removeListener('mcp:status', listener)
    }
  }
}
