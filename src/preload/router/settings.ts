import { ipcRenderer } from 'electron'
import { remove } from '../../main/store/controller'

export default {
  get: (key: string) => ipcRenderer.invoke('settings:get', key),
  getAll: () => ipcRenderer.invoke('settings:getAll'),
  set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
  remove: (key: string) => ipcRenderer.invoke('settings:remove', key)
}
