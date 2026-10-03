import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { IpcResult } from '../../main/chat/dto'
import type { AgentDraft, AgentMeta, AgentToolOption } from '../../main/agents/types'

export default {
  list: (): Promise<IpcResult<{ agents: AgentMeta[] }>> => ipcRenderer.invoke('agents:list'),
  setEnabled: (name: string, enabled: boolean): Promise<IpcResult<null>> =>
    ipcRenderer.invoke('agents:setEnabled', name, enabled),
  /** 在系统文件管理器里打开角色目录 */
  openDir: (): Promise<IpcResult<null>> => ipcRenderer.invoke('agents:openDir'),
  /** 工具白名单的候选列表 */
  listTools: (): Promise<IpcResult<{ tools: AgentToolOption[] }>> =>
    ipcRenderer.invoke('agents:listTools'),
  create: (draft: AgentDraft): Promise<IpcResult<null>> =>
    ipcRenderer.invoke('agents:create', draft),
  update: (name: string, draft: AgentDraft): Promise<IpcResult<null>> =>
    ipcRenderer.invoke('agents:update', name, draft),
  remove: (name: string): Promise<IpcResult<null>> => ipcRenderer.invoke('agents:remove', name),
  /** 订阅角色目录变化,返回取消订阅函数 */
  onChange: (callback: (agents: AgentMeta[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: AgentMeta[]): void => callback(payload)
    ipcRenderer.on('agents:change', listener)
    return () => {
      ipcRenderer.removeListener('agents:change', listener)
    }
  }
}
