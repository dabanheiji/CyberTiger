import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  TerminalEnsureDto,
  TerminalEvent,
  TerminalResizeDto,
  TerminalSessionInfo,
  TerminalWriteDto
} from '../../main/terminal/dto'
import type { IpcResult } from '../../main/chat/dto'

export default {
  /** 确保该会话的工作空间有一个 shell;返回回放快照,重载后靠它接回屏幕 */
  ensure: (dto: TerminalEnsureDto): Promise<IpcResult<TerminalSessionInfo>> =>
    ipcRenderer.invoke('terminal:ensure', dto),
  /** 键盘输入交给 shell;未知 terminalId 静默忽略 */
  write: (dto: TerminalWriteDto): Promise<IpcResult<null>> =>
    ipcRenderer.invoke('terminal:write', dto),
  resize: (dto: TerminalResizeDto): Promise<IpcResult<null>> =>
    ipcRenderer.invoke('terminal:resize', dto),
  /** 订阅输出与退出事件,返回取消订阅函数 */
  onEvent: (callback: (event: TerminalEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: TerminalEvent): void => callback(payload)
    ipcRenderer.on('terminal:event', listener)
    return () => {
      ipcRenderer.removeListener('terminal:event', listener)
    }
  }
}
