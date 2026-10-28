import { commandSegments } from '../tools/risk'
import type { HookEvent } from './types'

/**
 * 钩子的 matcher:一条钩子在两个工具事件上「管哪一次调用」。
 *
 * 与审批名单**刻意的分歧**必须写在这里,否则下一个读者会把它「修」成绕过:
 *
 * - 审批白名单要**每个分段都命中**才免审(见 `tools/permission.ts` 的 `allSegmentsCovered`)。
 *   那里保守的方向是「多问一次」。
 * - 这里要**任一分段命中**就算命中。拦下 `git push` 的钩子,在 `ls; git push --force` 上
 *   **必须也**触发 —— 只看第一段等于给拦截开了一扇「前面先跑一条无害命令」的门,
 *   而那正是所有人会用来绕开拦截的写法。
 *
 * 本模块不认识 electron、DB 与子进程。
 */

/** 一份声明里 matcher 条目的上限;与审批名单的上限分键,两处可以各自调整 */
export const MAX_MATCHER_ENTRIES = 100

/** 只有这两个事件带「哪次调用」这个概念;其余事件上给了 matcher 就忽略并记一行 */
export function matcherApplies(event: HookEvent): boolean {
  return event === 'beforeToolCall' || event === 'afterToolCall'
}

export interface HookMatchTarget {
  toolName: string
  /** 已解析的参数对象;解析不出来时是空对象,而原始串在 `command` 里另给 */
  args: Record<string, unknown>
}

/**
 * 这次调用里真正会被执行的那条命令。
 *
 * `background_job` 的 `action` 缺省即 `start`(与 `tools/permission.ts` 那条归一一致):
 * 漏掉 action 的调用会真的启动一条命令,而 matcher 若读成「没有命令」,
 * 拦 `docker compose` 的那一条就恰好在其上不开口。
 */
export function hookCommandOf(target: HookMatchTarget): string {
  const { toolName, args } = target
  if (toolName === 'run_command') return typeof args.command === 'string' ? args.command.trim() : ''
  if (toolName === 'background_job') {
    const action = typeof args.action === 'string' ? args.action.trim() : ''
    if (action !== '' && action !== 'start') return ''
    return typeof args.command === 'string' ? args.command.trim() : ''
  }
  return ''
}

/** 工具名条目与 MCP server 前缀条目都算「按名字命中」 */
function matchesToolName(entry: string, toolName: string): boolean {
  if (!entry) return false
  if (entry.endsWith('__')) return toolName.startsWith(entry)
  return toolName === entry
}

/**
 * 命令前缀按 **token 边界** 比对:条目切成 token,必须是该分段 argv 的前缀。
 * 所以 `git push` 认 `git push --force`,不认 `git pushstatus`。
 */
function matchesCommandPrefix(entry: string, argv: string[]): boolean {
  const tokens = entry.split(/\s+/).filter(Boolean)
  if (tokens.length === 0 || tokens.length > argv.length) return false
  return tokens.every((token, index) => token === argv[index])
}

/**
 * 解析不了(未闭合引号、奇怪的转义)时退回**按原文做词边界匹配**。
 *
 * 拦截侧猜不准就触发,与「宁可多拦一次」的方向一致 —— 反过来退回不触发等于把「看不懂」
 * 当成绕过手段,而最危险的写法恰好是解析不了的那一批(`cat f > /etc/hosts` 那类)。
 * 方向与 `tools/permission.ts` 的 `matchesRaw` 同源;白名单那侧相反,因为它保守的代价只是多问一次。
 */
function matchesRawPrefix(entry: string, command: string): boolean {
  const escaped = entry
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+')
  if (!escaped) return false
  return new RegExp(`(^|[^\\w./-])${escaped}($|[^\\w-])`).test(command)
}

/** 一个命令前缀条目在这条命令上命中? */
function prefixHits(prefix: string, command: string): boolean {
  const segments = commandSegments(command)
  if (segments) return segments.some((argv) => matchesCommandPrefix(prefix, argv))
  return matchesRawPrefix(prefix, command)
}

/**
 * 一条条目命中整个 matcher?空数组即全部命中(那是「这条钩子管所有工具调用」的意思)。
 */
function entryMatches(entry: string, target: HookMatchTarget, command: string): boolean {
  const trimmed = entry.trim()
  if (!trimmed) return false
  const colon = trimmed.indexOf(':')
  if (colon <= 0) return matchesToolName(trimmed, target.toolName)
  const tool = trimmed.slice(0, colon).trim()
  const prefix = trimmed.slice(colon + 1).trim()
  if (!tool || !prefix) return false
  // 命令前缀那种形状只对「这次调用真的带命令」的工具成立;别的工具上没有命令可比
  if (target.toolName !== tool || command === '') return false
  return prefixHits(prefix, command)
}

/** 这份 matcher 要不要为这次调用开口 */
export function matchesHook(matcher: string[], target: HookMatchTarget): boolean {
  if (matcher.length === 0) return true
  const command = hookCommandOf(target)
  return matcher.some((entry) => entryMatches(entry, target, command))
}

/**
 * 设置页的形状说明(**唯一一份**)。
 *
 * 渲染层 `lib/hookMatchers.ts` 同值抄一份,并由单测 `toEqual` 钉住两份相等 ——
 * 抄错了不会报错,只会让用户配出一条永远不生效的条目。
 */
export const HOOK_MATCHER_SHAPES: string[] = [
  '留空:该事件下的每一次调用都触发',
  '工具名:精确匹配该工具,如 write_file、github__create_issue',
  'server 前缀:以 __ 结尾,匹配该 MCP server 的全部工具,如 github__',
  '命令前缀:<工具名>:<命令前缀>,对 run_command 与 background_job 的 start 生效,按 token 边界匹配,如 run_command:git push',
  '与审批名单不同:命令前缀只要任一分段命中就触发,所以 `ls; git push` 也会被拦下'
]
