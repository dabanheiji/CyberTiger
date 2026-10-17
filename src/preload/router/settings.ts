import { ipcRenderer } from 'electron'
import type { AppSettings, SandboxExecStatus } from '../../main/store/types'

export default {
  get: <K extends keyof AppSettings>(key: K): Promise<AppSettings[K]> =>
    ipcRenderer.invoke('settings:get', key),
  getAll: (): Promise<AppSettings> => ipcRenderer.invoke('settings:getAll'),
  set: <K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void> =>
    ipcRenderer.invoke('settings:set', key, value),
  remove: (key: keyof AppSettings): Promise<void> => ipcRenderer.invoke('settings:remove', key),
  /**
   * 受限执行的引擎状态。不是设置值,所以不在 get/set 那一组里;
   * 结论在主进程一次探针里,渲染层只是读它 —— 界面上那颗开关显示的是设置,这一条显示的是能力。
   */
  sandboxStatus: (): Promise<SandboxExecStatus> => ipcRenderer.invoke('settings:sandboxStatus')
}
