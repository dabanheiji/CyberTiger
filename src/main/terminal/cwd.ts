import path from 'node:path'
import type { TerminalCwdSource } from './dto'

export interface CwdCandidate {
  dir: string
  source: TerminalCwdSource
}

export interface ResolvedCwd {
  cwd: string
  source: TerminalCwdSource
}

/**
 * 依次检查候选目录,取第一个真实存在的目录;都不成立时退到主目录。
 *
 * `isDirectory` 由调用方注入,所以这一层不碰 fs,候选顺序与回落结论能脱离应用断言。
 * 空串与纯空白跳过:会话还没选工作空间时 `getWorkspace` 返回的就是空串,
 * 那不是「一个叫空字符串的目录」。
 */
export function resolveTerminalCwd(
  candidates: readonly CwdCandidate[],
  isDirectory: (dir: string) => boolean,
  home: string
): ResolvedCwd {
  for (const candidate of candidates) {
    const dir = candidate.dir.trim()
    if (!dir) continue
    const absolute = path.resolve(dir)
    if (isDirectory(absolute)) return { cwd: absolute, source: candidate.source }
  }
  return { cwd: path.resolve(home), source: 'home' }
}
