/**
 * 终端 IPC 的跨进程契约。
 *
 * 渲染层只给会话 id 与尺寸,目录一律由主进程解析 —— 终端是自己的 shell,
 * 但「在哪个目录起」这件事不该由渲染层说了算。
 */
export type TerminalCwdSource = 'workspace' | 'default-workspace' | 'home'

export interface TerminalEnsureDto {
  /** 当前会话;草稿态传 null,主进程退回默认工作空间 / 主目录 */
  conversationId: string | null
  /** 首屏的列数 / 行数,缺省由主进程给 80×24 */
  cols?: number
  rows?: number
}

export interface TerminalWriteDto {
  terminalId: string
  data: string
}

export interface TerminalResizeDto {
  terminalId: string
  cols: number
  rows: number
}

export interface TerminalSessionInfo {
  terminalId: string
  cwd: string
  cwdSource: TerminalCwdSource
  /** shell 的程序名,界面上用来标注这一屏是什么(如 zsh / powershell.exe) */
  shell: string
  /** 已产生、可回放的输出(重载后补屏) */
  backlog: string
  /** 已经包含在 backlog 里的最后一条事件序号;0 表示还没有输出 */
  seq: number
}

export type TerminalEvent =
  | { type: 'data'; terminalId: string; seq: number; data: string }
  | { type: 'exit'; terminalId: string; code: number; signal?: number }
