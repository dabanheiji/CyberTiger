import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * 展开开头的 `~`。
 * 只有经过 shell 的命令才会自动展开,而这里的相对路径是交给 path.resolve、
 * cwd 是交给 spawn 的,都不走 shell —— 模型很爱写 `~/Desktop/notes.md`,不展开就找不到了。
 */
export function expandHome(target: string): string {
  if (target === '~') return os.homedir()
  if (target.startsWith('~/') || target.startsWith('~\\')) {
    return path.join(os.homedir(), target.slice(2))
  }
  return target
}

/** 把 path 解析成绝对路径:相对路径落在应用当前目录,调用方要把结果回给用户看 */
export function resolvePath(target: string): string {
  return path.resolve(expandHome(target.trim()))
}

/** node 的 errno 码 → 一句能照着改的中文;码不在表里就退回原始 message */
const ERRNO_HINTS: Record<string, string> = {
  ENOENT: '路径不存在',
  EACCES: '没有访问权限',
  EPERM: '操作被系统拒绝',
  EISDIR: '目标是一个目录',
  ENOTDIR: '路径中间有一段不是目录',
  ENAMETOOLONG: '路径过长',
  EROFS: '目标在只读文件系统上',
  EBUSY: '目标正被占用',
  EMFILE: '打开的文件过多'
}

/** 把 fs 错误转成面向模型的中文说明(带原始 message,里面通常有出问题的路径) */
export function describeFsError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    const hint = code ? ERRNO_HINTS[code] : undefined
    return hint ? `${hint}(错误码 ${code}):${error.message}` : error.message
  }
  return String(error)
}

/**
 * 存在性探测:不存在(或路径中段不是目录)返回 undefined,其余错误原样抛出。
 * 调用方靠它区分「新建」与「覆盖」,而不必为每种写操作再判一次 errno。
 */
export async function statIfExists(target: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.stat(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
}
