import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { IpcResult } from '../../main/chat/dto'
import type { HookDraft } from '../../main/hooks/types'
import type { HookExecution, HookRow } from '../../main/hooks/dto'

export default {
  /** 声明本身 + 主进程才算得出的两件事(命令的真身、这一条现在跑在哪一侧),外加两个目录 */
  list: (): Promise<IpcResult<{ hooks: HookRow[]; dir: string; logPath: string }>> =>
    ipcRenderer.invoke('hooks:list'),
  setEnabled: (name: string, enabled: boolean): Promise<IpcResult<null>> =>
    ipcRenderer.invoke('hooks:setEnabled', name, enabled),
  create: (draft: HookDraft): Promise<IpcResult<null>> => ipcRenderer.invoke('hooks:create', draft),
  update: (name: string, draft: HookDraft): Promise<IpcResult<null>> =>
    ipcRenderer.invoke('hooks:update', name, draft),
  remove: (name: string): Promise<IpcResult<null>> => ipcRenderer.invoke('hooks:remove', name),
  /** 「最近执行」:拉取式,新的在前;没有事件,与 chat:pendingApprovals 同一条路 */
  recent: (limit?: number): Promise<IpcResult<HookExecution[]>> =>
    ipcRenderer.invoke('hooks:recent', limit),
  /** 在系统文件管理器里打开 hooks 目录 */
  openDir: (): Promise<IpcResult<null>> => ipcRenderer.invoke('hooks:openDir'),
  /** 在系统里打开那份日志:钩子排障的唯一入口 */
  openLog: (): Promise<IpcResult<null>> => ipcRenderer.invoke('hooks:openLog'),
  /** 订阅钩子目录变化,返回取消订阅函数 */
  onChange: (callback: (hooks: HookRow[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: HookRow[]): void => callback(payload)
    ipcRenderer.on('hooks:change', listener)
    return () => {
      ipcRenderer.removeListener('hooks:change', listener)
    }
  }
}
