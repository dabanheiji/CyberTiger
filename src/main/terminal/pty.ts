import { createRequire } from 'node:module'
import type { PtyHandle } from './manager'
import type { ShellSpec } from './shell'

interface PtyProcess {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(callback: (data: string) => void): void
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string
      cols: number
      rows: number
      cwd: string
      env: Record<string, string>
    }
  ): PtyProcess
}

let cached: NodePtyModule | null = null

/**
 * node-pty 是原生模块,懒加载而不是顶层 import:装不上 / 平台不匹配时只有「点开终端」失败,
 * 不把整个主进程的启动一起带走。主进程产物是 CJS,这里拿到的就是 externalize 后的依赖。
 */
function loadPty(): NodePtyModule {
  if (cached) return cached
  try {
    // 主进程产物是 CJS(__filename 存在),createRequire 拿到的就是 externalize 后的那个模块
    cached = createRequire(__filename)('node-pty') as NodePtyModule
    return cached
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`无法加载终端组件 node-pty：${reason}`)
  }
}

export function spawnPty(spec: ShellSpec, cwd: string, cols: number, rows: number): PtyHandle {
  const proc = loadPty().spawn(spec.file, spec.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: spec.env
  })
  return {
    write: (data) => proc.write(data),
    resize: (nextCols, nextRows) => proc.resize(nextCols, nextRows),
    kill: () => proc.kill(),
    onData: (callback) => proc.onData(callback),
    onExit: (callback) => proc.onExit(callback)
  }
}
