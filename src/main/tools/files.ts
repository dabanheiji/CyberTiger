import fs from 'fs'
import path from 'path'
import { describeFsError, resolvePath, statIfExists } from './paths'
import type { ToolDefinition } from './types'

/**
 * 单次返回的正文长度上限(字符)。
 * 再长就该分段读:一把灌进上下文会挤掉整段对话,而模型通常只需要其中一段。
 */
const READ_MAX_CHARS = 24_000

/** 超过这个大小的文件不整体读进内存 —— 多半是构建产物或二进制 */
const READ_MAX_FILE_BYTES = 2 * 1024 * 1024

/** 判断是否二进制时只扫描开头这么多字节 */
const BINARY_SNIFF_BYTES = 8_000

/** 报尺寸用的短格式,几十 KB 与几十万字节对模型是同一个量级的噪声 */
function formatSize(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`
}

/** 文本文件不会出现 NUL,开头有 NUL 就按二进制处理 */
function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)
}

/** offset 从 1 起;省略即第一行,给了但不是正整数就拒绝,不悄悄当 1 */
function offsetOf(value: unknown): number {
  if (value === undefined || value === null || value === '') return 1
  const parsed = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`offset 要是从 1 开始的整数行号,收到的是 ${String(value)}`)
  }
  return parsed
}

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description:
    '读取一个文本文件,返回不带行号的原文。路径可以是绝对路径、以 ~ 开头的路径,或相对应用当前目录的路径;' +
    '结尾会写明实际读取的绝对路径与行数。' +
    '文件较长时只返回从 offset 行起的一段,并说明已读到第几行、下一段该从哪行继续。' +
    "只处理文本:二进制文件,以及超过 2 MB 的大文件会被拒绝,后者改用 run_command 按行取片段(如 sed -n '1,200p')。",
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要读取的文件路径' },
      offset: { type: 'number', description: '从第几行开始读,从 1 起;省略即第 1 行' }
    },
    required: ['path']
  },
  execute: async (args): Promise<string> => {
    const raw = String(args.path ?? '').trim()
    if (!raw) throw new Error('缺少 path')
    const filePath = resolvePath(raw)
    const start = offsetOf(args.offset)

    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(filePath)
    } catch (error) {
      throw new Error(`读取 ${filePath} 失败:${describeFsError(error)}`)
    }
    if (stat.isDirectory()) throw new Error(`${filePath} 是一个目录,不是文件`)
    if (stat.size > READ_MAX_FILE_BYTES) {
      throw new Error(
        `${filePath} 有 ${formatSize(stat.size)},超过单次读取上限 ` +
          `${formatSize(READ_MAX_FILE_BYTES)}。用 run_command 取其中一段,例如 sed -n '1,200p' ${filePath}`
      )
    }

    let buffer: Buffer
    try {
      buffer = await fs.promises.readFile(filePath)
    } catch (error) {
      throw new Error(`读取 ${filePath} 失败:${describeFsError(error)}`)
    }
    if (looksBinary(buffer)) {
      throw new Error(`${filePath} 看起来是二进制文件(开头出现了 NUL 字节),本工具只读文本`)
    }
    if (buffer.length === 0) return `${filePath} 是空文件(0 字节)`

    const lines = buffer.toString('utf8').split('\n')
    if (start > lines.length) {
      throw new Error(`${filePath} 只有 ${lines.length} 行,offset=${start} 已超出`)
    }

    // 至少保留一行:单行本身就超上限时若照上限切会返回空正文,模型会当文件是空的
    let end = start
    let chars = 0
    while (
      end < lines.length &&
      (end === start || chars + lines[end].length + 1 <= READ_MAX_CHARS)
    ) {
      chars += lines[end].length + 1
      end += 1
    }

    let body = lines.slice(start - 1, end).join('\n')
    // 那一行仍按字符切:整条灌进上下文正是上限要防的事(压缩过的 JSON 就是这么一行)
    const lineCut = body.length > READ_MAX_CHARS
    if (lineCut) body = body.slice(0, READ_MAX_CHARS)

    const reachedEnd = end >= lines.length && !lineCut
    const note =
      start === 1 && reachedEnd
        ? `${filePath}:${lines.length} 行,${formatSize(stat.size)}`
        : `${filePath} 共 ${lines.length} 行,本次返回第 ${start}-${end} 行` +
          (lineCut ? '(该行本身超过上限,已按字符截断)' : '') +
          (reachedEnd ? '' : `;继续读把 offset 设为 ${end + 1}`)
    return `${body}\n\n---\n[${note}]`
  }
}

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description:
    '把一份完整文本写入文件:默认整文件覆盖(旧内容不保留),append=true 时追加到末尾;' +
    '父目录不存在会自动创建。路径支持绝对路径与 ~ 开头,返回值写明实际写入的绝对路径、' +
    '写入字节数,以及覆盖模式下原先有多大内容。' +
    'content 是整份正文且必填,缺省时调用直接被拒绝 —— 那等于把文件清空。' +
    '二进制文件(图片、压缩包等)不用本工具。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要写入的文件路径' },
      content: { type: 'string', description: '要写入的完整正文' },
      append: { type: 'boolean', description: 'true 时追加到末尾;默认 false,即整文件覆盖' }
    },
    required: ['path', 'content']
  },
  execute: async (args): Promise<string> => {
    const raw = String(args.path ?? '').trim()
    if (!raw) throw new Error('缺少 path')
    if (typeof args.content !== 'string') {
      throw new Error('缺少 content:本工具写的是整份正文,少这个参数会把文件清空,所以拒绝执行')
    }
    const filePath = resolvePath(raw)
    const append = args.append === true

    const existing = await statIfExists(filePath)
    if (existing?.isDirectory()) throw new Error(`${filePath} 是一个目录,不是文件`)

    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
      await fs.promises.writeFile(filePath, args.content, {
        encoding: 'utf8',
        flag: append ? 'a' : 'w'
      })
    } catch (error) {
      throw new Error(`写入 ${filePath} 失败:${describeFsError(error)}`)
    }

    const written = Buffer.byteLength(args.content, 'utf8')
    if (append) {
      return `已追加 ${formatSize(written)} 到 ${filePath}${existing ? '' : '(原本不存在,已新建)'}`
    }
    return existing
      ? `已覆盖 ${filePath} 原有的 ${formatSize(existing.size)} 内容,本次写入 ${formatSize(written)}`
      : `已新建 ${filePath},写入 ${formatSize(written)}`
  }
}

export const fileTools: ToolDefinition[] = [readFileTool, writeFileTool]
