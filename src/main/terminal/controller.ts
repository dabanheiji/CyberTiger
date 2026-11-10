import fs from 'node:fs'
import os from 'node:os'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { getWorkspace } from '../chat/service'
import type { IpcResult } from '../chat/dto'
import { store } from '../store'
import type {
  TerminalEnsureDto,
  TerminalResizeDto,
  TerminalSessionInfo,
  TerminalWriteDto
} from './dto'
import { resolveTerminalCwd } from './cwd'
import { TerminalManager } from './manager'
import { spawnPty } from './pty'
import { shellSpec } from './shell'

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false
  } catch {
    return false
  }
}

const terminalManager = new TerminalManager({
  resolveCwd: (conversationId) => {
    // 目录只由主进程决定:渲染层给的是会话 id,不是路径
    const workspace = conversationId ? getWorkspace(conversationId) : ''
    const defaultWorkspace = store.get('defaultWorkspace') ?? ''
    const resolved = resolveTerminalCwd(
      [
        { dir: workspace, source: 'workspace' },
        { dir: defaultWorkspace, source: 'default-workspace' }
      ],
      isDirectory,
      os.homedir()
    )
    return { cwd: resolved.cwd, cwdSource: resolved.source }
  },
  shell: () => shellSpec(process.platform, process.env, os.homedir()),
  spawn: spawnPty,
  schedule: (callback, ms) => setTimeout(callback, ms),
  cancel: (handle) => clearTimeout(handle as NodeJS.Timeout)
})

/** 统一包装 handler 结果,异常转为 { success: false, msg } */
function run<T>(fn: () => T): IpcResult<T> {
  try {
    return { success: true, data: fn() }
  } catch (error) {
    return { success: false, msg: error instanceof Error ? error.message : String(error) }
  }
}

export function ensure(
  _e: IpcMainInvokeEvent,
  dto: TerminalEnsureDto
): IpcResult<TerminalSessionInfo> {
  return run(() => terminalManager.ensure(dto))
}

export function write(_e: IpcMainInvokeEvent, dto: TerminalWriteDto): IpcResult<null> {
  return run(() => {
    terminalManager.write(dto.terminalId, dto.data)
    return null
  })
}

export function resize(_e: IpcMainInvokeEvent, dto: TerminalResizeDto): IpcResult<null> {
  return run(() => {
    terminalManager.resize(dto.terminalId, dto.cols, dto.rows)
    return null
  })
}

/**
 * 把终端事件接到这个窗口。窗口关闭时退订并收掉全部 shell —— 窗口没了还留着一屏看不见的
 * 进程,下次又从别处冒出来,是最难解释的一种残留。退出应用时再调一次 `disposeTerminals`(幂等)。
 */
export function initTerminal(win: BrowserWindow): void {
  const unsubscribe = terminalManager.onEvent((event) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send('terminal:event', event)
  })
  win.once('closed', () => {
    unsubscribe()
    terminalManager.disposeAll()
  })
}

export function disposeTerminals(): void {
  terminalManager.disposeAll()
}
