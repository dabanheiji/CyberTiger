import { BrowserWindow, dialog, shell, type IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '../chat/dto'
import { skillRegistry, skillsDir } from './registry'
import {
  discoverRemote,
  discoverLocal,
  install as installSkills,
  cancelDiscover,
  uninstall as uninstallSkill,
  update as updateSkill,
  cleanupTemp
} from './installer'
import type { DiscoverResult, InstallResult, SkillMeta } from './types'

function run<T>(fn: () => T): IpcResult<T> {
  try {
    return { success: true, data: fn() }
  } catch (error) {
    return { success: false, msg: error instanceof Error ? error.message : String(error) }
  }
}

async function runAsync<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return { success: false, msg: error instanceof Error ? error.message : String(error) }
  }
}

/** 应用启动时:扫描目录、监听变化并广播到所有窗口 */
export function initSkills(): void {
  cleanupTemp()
  skillRegistry.init()
  skillRegistry.onChange((skills) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('skills:change', skills)
    }
  })
}

export function list(): IpcResult<{ skills: SkillMeta[] }> {
  return run(() => ({ skills: skillRegistry.list() }))
}

export function setEnabled(
  _e: IpcMainInvokeEvent,
  name: string,
  enabled: boolean
): IpcResult<null> {
  return run(() => {
    skillRegistry.setEnabled(name, enabled)
    return null
  })
}

export function openDir(): Promise<IpcResult<null>> {
  return runAsync(async () => {
    const err = await shell.openPath(skillsDir())
    if (err) throw new Error(err)
    return null
  })
}

export function discover(_e: IpcMainInvokeEvent, input: string): Promise<IpcResult<DiscoverResult>> {
  return runAsync(() => discoverRemote(input))
}

/** 弹系统对话框选文件夹或 zip;取消时返回 null */
export function importLocal(e: IpcMainInvokeEvent): Promise<IpcResult<DiscoverResult | null>> {
  return runAsync(async () => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options: Electron.OpenDialogOptions = {
      title: '选择 skill 文件夹或 zip',
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'Zip 或文件夹', extensions: ['zip'] }]
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return discoverLocal(result.filePaths[0])
  })
}

export function install(
  _e: IpcMainInvokeEvent,
  sessionId: string,
  names: string[],
  overwrite: boolean
): Promise<IpcResult<InstallResult>> {
  return runAsync(() => installSkills(sessionId, names, overwrite))
}

export function cancel(_e: IpcMainInvokeEvent, sessionId: string): IpcResult<null> {
  return run(() => {
    cancelDiscover(sessionId)
    return null
  })
}

export function uninstall(_e: IpcMainInvokeEvent, name: string): Promise<IpcResult<null>> {
  return runAsync(async () => {
    await uninstallSkill(name)
    return null
  })
}

export function update(_e: IpcMainInvokeEvent, name: string): Promise<IpcResult<InstallResult>> {
  return runAsync(() => updateSkill(name))
}
