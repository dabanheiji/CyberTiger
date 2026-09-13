import { ipcMain } from 'electron'
import { get, getAll, set, remove } from '../store/controller'

export function registerIpc(): void {
  ipcMain.handle('settings:get', get)
  ipcMain.handle('settings:getAll', getAll)
  ipcMain.handle('settings:set', set)
  ipcMain.handle('settings:remove', remove)
}
