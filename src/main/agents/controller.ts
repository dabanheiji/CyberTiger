import { BrowserWindow, shell, type IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '../chat/dto'
import { builtinTools, getAllTools } from '../tools/registry'
import { agentRegistry, agentsDir } from './registry'
import type { AgentDraft, AgentMeta, AgentToolOption } from './types'

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

/** 应用启动时:扫描角色目录、监听变化并广播到所有窗口 */
export function initAgents(): void {
  agentRegistry.init()
  agentRegistry.onChange((agents) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('agents:change', agents)
    }
  })
}

export function list(): IpcResult<{ agents: AgentMeta[] }> {
  return run(() => ({ agents: agentRegistry.list() }))
}

export function setEnabled(
  _e: IpcMainInvokeEvent,
  name: string,
  enabled: boolean
): IpcResult<null> {
  return run(() => {
    agentRegistry.setEnabled(name, enabled)
    return null
  })
}

/** 工具白名单的候选项;task 本身不在 getAllTools 里,所以不会被子 Agent 选中 */
export function listTools(): IpcResult<{ tools: AgentToolOption[] }> {
  return run(() => {
    const builtinNames = new Set(builtinTools.map((t) => t.name))
    return {
      tools: getAllTools().map((t) => ({
        name: t.name,
        description: t.description,
        source: builtinNames.has(t.name) ? '内置' : 'MCP'
      }))
    }
  })
}

export function create(_e: IpcMainInvokeEvent, draft: AgentDraft): Promise<IpcResult<null>> {
  return runAsync(async () => {
    await agentRegistry.create(draft)
    return null
  })
}

export function update(
  _e: IpcMainInvokeEvent,
  name: string,
  draft: AgentDraft
): Promise<IpcResult<null>> {
  return runAsync(async () => {
    await agentRegistry.update(name, draft)
    return null
  })
}

export function remove(_e: IpcMainInvokeEvent, name: string): Promise<IpcResult<null>> {
  return runAsync(async () => {
    await agentRegistry.remove(name)
    return null
  })
}

export function openDir(): Promise<IpcResult<null>> {
  return runAsync(async () => {
    const error = await shell.openPath(agentsDir())
    if (error) throw new Error(error)
    return null
  })
}
