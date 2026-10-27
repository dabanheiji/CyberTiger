import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

/**
 * 杀**整棵树**。
 *
 * POSIX 上子进程是 `detached` 起的,于是它自己就是组长,负号 pid 一次收掉整组;
 * Windows 没有进程组,`child.kill()` 只杀 cmd.exe 那一层,孙子进程会留在机器上,
 * 所以必须让 taskkill 按树杀(`/T`)并强制结束(`/F`)。
 */
export function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
      // 没有监听器的 'error' 会直接抛穿整个进程
      killer.on('error', () => undefined)
    } catch {
      // 连 taskkill 都起不来时只能放弃;调用方还有兜底的定时器
    }
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    // ESRCH:整组已经退了,没有要杀的
  }
}

export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    try {
      child.kill(signal)
    } catch {
      // 同上:已经退了
    }
    return
  }
  killGroup(child.pid, signal)
}

/**
 * 进程组里还有没有活着的成员。
 *
 * `EPERM` 也算活着 —— 那只是「这个进程不归我们管」,不是「它没了」。
 * 反过来,把 EPERM 当成死了会让清扫放过一个真在跑的作业。
 */
export function groupAlive(pid: number): boolean {
  if (!pid) return false
  if (process.platform === 'win32') return pidAlive(pid)
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function pidAlive(pid: number): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
