import { ipcRenderer } from 'electron'
import type { AppSettings } from '../../main/store/types'

export default {
  get: <K extends keyof AppSettings>(key: K): Promise<AppSettings[K]> =>
    ipcRenderer.invoke('settings:get', key),
  getAll: (): Promise<AppSettings> => ipcRenderer.invoke('settings:getAll'),
  set: <K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void> =>
    ipcRenderer.invoke('settings:set', key, value),
  remove: (key: keyof AppSettings): Promise<void> => ipcRenderer.invoke('settings:remove', key)
}
