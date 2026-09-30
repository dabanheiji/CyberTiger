import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { IpcResult } from '../../main/chat/dto'
import type { DiscoverResult, InstallResult, SkillMeta } from '../../main/skills/types'

export default {
  list: (): Promise<IpcResult<{ skills: SkillMeta[] }>> => ipcRenderer.invoke('skills:list'),
  setEnabled: (name: string, enabled: boolean): Promise<IpcResult<null>> =>
    ipcRenderer.invoke('skills:setEnabled', name, enabled),
  /** 在系统文件管理器里打开 skills 目录 */
  openDir: (): Promise<IpcResult<null>> => ipcRenderer.invoke('skills:openDir'),
  /** 从 owner/repo、GitHub 链接或 zip 直链下载并列出候选 */
  discover: (input: string): Promise<IpcResult<DiscoverResult>> =>
    ipcRenderer.invoke('skills:discover', input),
  /** 弹系统对话框选本地文件夹或 zip;取消时 data 为 null */
  importLocal: (): Promise<IpcResult<DiscoverResult | null>> =>
    ipcRenderer.invoke('skills:importLocal'),
  install: (sessionId: string, names: string[], overwrite: boolean): Promise<IpcResult<InstallResult>> =>
    ipcRenderer.invoke('skills:install', sessionId, names, overwrite),
  /** 放弃本次安装,清理临时文件 */
  cancel: (sessionId: string): Promise<IpcResult<null>> =>
    ipcRenderer.invoke('skills:cancel', sessionId),
  uninstall: (name: string): Promise<IpcResult<null>> =>
    ipcRenderer.invoke('skills:uninstall', name),
  update: (name: string): Promise<IpcResult<InstallResult>> =>
    ipcRenderer.invoke('skills:update', name),
  /** 订阅目录变化,返回取消订阅函数 */
  onChange: (callback: (skills: SkillMeta[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: SkillMeta[]): void => callback(payload)
    ipcRenderer.on('skills:change', listener)
    return () => {
      ipcRenderer.removeListener('skills:change', listener)
    }
  }
}
