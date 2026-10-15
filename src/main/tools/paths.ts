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

export interface Anchored {
  /** 锚定后的绝对路径 */
  path: string
  /** true = 不在本次会话的工作空间子树内;仍可访问,只在结果里标注一句 */
  outside: boolean
}

/**
 * 把模型给的路径锚定到会话工作空间:绝对路径原样,`~` 前缀优先展开,
 * 其余按工作空间解析;没有工作空间时退回应用当前目录(即没这功能之前的行为)。
 *
 * outside 用 resolve + relative 的**纯文本**判断,不引 fs.realpath:
 * macOS 上 `/tmp` 是 `/private/tmp` 的软链,工作空间或路径只要有一边经过软链,
 * realpath 才认得出是同一个目录 —— 但它要为每次调用多一次 IO 和一套失败分支,
 * 而判错的代价只是多写一行标注,不影响能不能读到文件。这个取舍值得这么换。
 */
export function anchor(target: string, workspace: string): Anchored {
  const dir = workspace.trim()
  const resolved = path.resolve(dir || process.cwd(), expandHome(target.trim()))
  // 没选工作空间时无处可「越」,基准点是碰巧的进程目录,标出来只会误导
  if (!dir) return { path: resolved, outside: false }
  const relative = path.relative(dir, resolved)
  return {
    path: resolved,
    outside: relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))
  }
}

/** 越界时在结果末尾追加那一句;未越界原样返回 */
export function annotate(text: string, target: Anchored, workspace: string): string {
  if (!target.outside) return text
  // 措辞用陈述句:只说清事实,不暗示模型「不该」访问工作空间外的路径
  return `${text}\n\n[注:${target.path} 在本次会话的工作空间 ${workspace} 之外]`
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
