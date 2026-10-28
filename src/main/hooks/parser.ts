import { stringify as stringifyYaml } from 'yaml'
import { asOptionalString, parseFrontmatter, validateName } from '../shared/frontmatter'
import { HOOK_EVENTS } from './types'
import type { HookDraft, HookEvent, HookMeta } from './types'
import { MAX_MATCHER_ENTRIES } from './matcher'

/** 声明里各字段的上限;每一条都对应用可能写下的坏东西 */
const MAX_COMMAND_CHARS = 1024
const MAX_ARG_ITEMS = 64
const MAX_ARG_CHARS = 4096
const MAX_MATCHER_CHARS = 512
const MAX_DOC_CHARS = 8000

/** `timeout` 的缺省与上限:钩子是同步挡在流水线上的,60 秒已经是用户能感知的停顿 */
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000
export const MAX_HOOK_TIMEOUT_MS = 60_000

function validateEvent(value: unknown): HookEvent {
  const known = HOOK_EVENTS as readonly string[]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`缺少 event,必须是 ${known.join(' / ')} 之一`)
  }
  const event = value.trim()
  if (!known.includes(event)) {
    throw new Error(`event "${event}" 认不出来,必须是 ${known.join(' / ')} 之一`)
  }
  return event as HookEvent
}

/**
 * `sandboxed` 与 `once` 只认 YAML 的真与假。
 *
 * 安全字段不能按「有值即开启」读,也不能按字符串读:`sandboxed: "false"` 被当成开启只是难用,
 * 而 `sandboxed: no`(YAML 里也是假)写成字符串就是**把一条本该关进边界的钩子放出去**,
 * 所以这里宁可报错也不猜。
 */
function validateFlag(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    throw new Error(`${field} 必须是 true 或 false,收到的是 ${JSON.stringify(value)}`)
  }
  return value
}

/** 字符串数组字段:缺省即空数组,超长与含非字符串都直接报错 */
function validateList(
  value: unknown,
  field: string,
  maxItems: number,
  maxChars: number
): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`)
  if (value.length > maxItems) throw new Error(`${field} 最多 ${maxItems} 条`)
  return value.map((item) => {
    if (typeof item !== 'string') throw new Error(`${field} 只能包含字符串`)
    if (item.length > maxChars) throw new Error(`${field} 里每条不能超过 ${maxChars} 个字符`)
    return item
  })
}

function validateCommand(value: unknown): string {
  const command = asOptionalString(value, 'command', MAX_COMMAND_CHARS)
  if (command === undefined || command.trim() === '') {
    throw new Error('缺少 command:那是在这台机器上真实执行的可执行程序')
  }
  return command.trim()
}

function validateDescription(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('缺少 description')
  if (value.length > 1024) throw new Error('description 不能超过 1024 个字符')
  return value.trim()
}

function validateTimeout(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_HOOK_TIMEOUT_MS
  const ms = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`timeout 要是正数毫秒,收到的是 ${JSON.stringify(value)}`)
  }
  if (ms > MAX_HOOK_TIMEOUT_MS) {
    throw new Error(`timeout 不能超过 ${MAX_HOOK_TIMEOUT_MS} 毫秒`)
  }
  return Math.floor(ms)
}

/**
 * 解析并校验 `HOOK.md`。
 *
 * `dir` 是这条钩子自己的目录,`command` 的相对路径与进程的 cwd 都以它为基准(见 `contract.ts`)。
 * `dirName` 传了才校验「name 必须与目录名一致」—— 目录才是身份,设置页新建时先校验再落盘。
 */
export function parseHookFile(content: string, dir: string, dirName?: string): HookMeta {
  const { data, body } = parseFrontmatter(content)
  const doc = body.trim()
  if (doc.length > MAX_DOC_CHARS) throw new Error(`正文说明不能超过 ${MAX_DOC_CHARS} 个字符`)
  return {
    name: validateName(data.name, dirName),
    description: validateDescription(data.description),
    event: validateEvent(data.event),
    command: validateCommand(data.command),
    args: validateList(data.args, 'args', MAX_ARG_ITEMS, MAX_ARG_CHARS) ?? [],
    matcher: validateList(data.matcher, 'matcher', MAX_MATCHER_ENTRIES, MAX_MATCHER_CHARS) ?? [],
    sandboxed: validateFlag(data.sandboxed, 'sandboxed', false),
    timeoutMs: validateTimeout(data.timeout),
    once: validateFlag(data.once, 'once', false),
    doc,
    dir,
    // 启停是应用侧的状态,不属于这份文件:磁盘上写下来即「用户要它」,没勾回来由 registry 关掉
    enabled: true
  }
}

/**
 * 把设置页提交的内容校验并序列化成 `HOOK.md`。
 *
 * 与 `parseHookFile` 共用同一套校验,免得前端放过、落盘后才报错;键序固定,
 * 这样同一个草稿两次保存出来的文件逐字节相同(界面依赖这一点判断「有没有改动」)。
 */
export function buildHookFile(draft: HookDraft): { name: string; content: string } {
  const name = validateName(draft.name, undefined)
  const description = validateDescription(draft.description)
  const event = validateEvent(draft.event)
  const command = validateCommand(draft.command)
  const args = validateList(draft.args, 'args', MAX_ARG_ITEMS, MAX_ARG_CHARS) ?? []
  const matcher =
    validateList(draft.matcher, 'matcher', MAX_MATCHER_ENTRIES, MAX_MATCHER_CHARS) ?? []
  const sandboxed = validateFlag(draft.sandboxed, 'sandboxed', false)
  const timeoutMs = validateTimeout(draft.timeout)
  const once = validateFlag(draft.once, 'once', false)
  const doc = (draft.doc ?? '').trim()
  if (doc.length > MAX_DOC_CHARS) throw new Error(`正文说明不能超过 ${MAX_DOC_CHARS} 个字符`)

  const front: Record<string, unknown> = {
    name,
    description,
    event,
    command,
    sandboxed,
    timeout: timeoutMs,
    once
  }
  // 空数组不写:写出来是一条 `args: []`,而它对用户读起来像「这里漏填了」
  if (args.length > 0) front.args = args
  if (matcher.length > 0) front.matcher = matcher

  const body = doc ? `${doc}\n` : '\n'
  return { name, content: `---\n${stringifyYaml(front).trimEnd()}\n---\n\n${body}` }
}
