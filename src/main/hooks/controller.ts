import { BrowserWindow, shell, type IpcMainInvokeEvent } from 'electron'
import { sandboxStatus } from '../store/controller'
import type { IpcResult } from '../chat/dto'
import { hookRegistry, hooksDir } from './registry'
import { hooksLogPath, recentHooks } from './log'
import type { HookDraft } from './types'
import type { HookExecution, HookRow } from './dto'

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

/**
 * 「这一条现在跑在哪一侧」要一次引擎预检,而预检在进程内 memo、永不 reject,
 * 所以它可以出现在广播路径上:界面拿到的每一行都带着同一种结论,不必自己再拼一次。
 */
async function pushRows(): Promise<void> {
  const rows = hookRegistry.rows(await sandboxStatus())
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('hooks:change', rows)
  }
}

/** 应用启动时:扫描钩子目录、监听变化并广播 */
export function initHooks(): void {
  hookRegistry.init()
  hookRegistry.onChange(() => {
    void pushRows()
  })
}

export function list(): Promise<IpcResult<{ hooks: HookRow[]; dir: string; logPath: string }>> {
  return runAsync(async () => ({
    hooks: hookRegistry.rows(await sandboxStatus()),
    dir: hooksDir(),
    logPath: hooksLogPath()
  }))
}

export function setEnabled(
  _e: IpcMainInvokeEvent,
  name: string,
  enabled: boolean
): IpcResult<null> {
  return run(() => {
    hookRegistry.setEnabled(name, enabled)
    return null
  })
}

export function create(_e: IpcMainInvokeEvent, draft: HookDraft): Promise<IpcResult<null>> {
  return runAsync(async () => {
    await hookRegistry.create(draft)
    return null
  })
}

export function update(
  _e: IpcMainInvokeEvent,
  name: string,
  draft: HookDraft
): Promise<IpcResult<null>> {
  return runAsync(async () => {
    await hookRegistry.update(name, draft)
    return null
  })
}

export function remove(_e: IpcMainInvokeEvent, name: string): Promise<IpcResult<null>> {
  return runAsync(async () => {
    await hookRegistry.remove(name)
    return null
  })
}

/**
 * 「最近执行」那张表:拉取式,没有事件 —— 与 `chat:pendingApprovals`、`jobManager.list` 同一条路。
 * 钩子每次触发都记一行,所以界面要么按需读一次,要么在 `hooks:change` 之后重读。
 */
export function recent(_e: IpcMainInvokeEvent, limit?: number): IpcResult<HookExecution[]> {
  return run(() => recentHooks(limit))
}

export function openDir(): Promise<IpcResult<null>> {
  return runAsync(async () => {
    const error = await shell.openPath(hooksDir())
    if (error) throw new Error(error)
    return null
  })
}

/** 在系统里打开那份日志:钩子排障的唯一入口,比让用户去终端敲路径省事 */
export function openLog(): Promise<IpcResult<null>> {
  return runAsync(async () => {
    const error = await shell.openPath(hooksLogPath())
    if (error) throw new Error(error)
    return null
  })
}
