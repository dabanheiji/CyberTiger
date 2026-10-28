import path from 'path'
import { expandHome } from '../tools/paths'
import type { RunScope, TokenUsage, ToolCallRecord } from '../chat/dto'
import type { ChatCompletionMessage } from '../chat/llm'
import { HOOK_CONTRACT_VERSION } from './types'
import type { HookEvent, HookMeta, HookReply } from './types'

/**
 * 钩子的 stdin / stdout 契约:一段 JSON 进去,一段 JSON 出来,判定只在这一个文件里做。
 *
 * 三条刻意的省略,各自的理由写在对应字段上:**不给工具定义**(改写工具集是另一件事,
 * 只给本步真正下发的工具名),**`afterRequest` 不给整份消息**(`after*` 没有改写权,
 * 给完整数组只为审计,而审计归 JSONL),**不走环境变量**(stdin 是唯一通道,
 * 两条通道就是两条真值,而 env 的尺寸上限各平台坏法不同)。
 */

/** 一次 payload 的字节上限:超过就**跳过这条钩子**,不把主进程压在一个 GB 级字符串上 */
export const MAX_HOOK_PAYLOAD_BYTES = 32 * 1024 * 1024

/** 钩子 stdout 的默认上限 */
export const MAX_HOOK_REPLY_BYTES = 64 * 1024

/**
 * `beforeRequest` 那一支放宽到 8 MiB。
 *
 * 它要回的是整份改写后的出站消息,而那份东西正常就有 MB 级(预算是窗口 × 85%,
 * 128k 模型约 100k token)。用默认的 64 KiB 去读,等于每条真会改写上下文的钩子都超限。
 */
export const MAX_REWRITE_REPLY_BYTES = 8 * 1024 * 1024

/** 一步里最多采纳几条说明:没有上限时碎嘴的钩子会把裁剪推进缩写档,开始裁真正的工具结果 */
export const MAX_NOTES_PER_STEP = 8

const REQUEST_CHARS = 2_000
const CONTENT_CHARS = 8_000
const REASONING_CHARS = 2_000
const RESULT_CHARS = 4_000
const ARGUMENTS_CHARS = 4_000
const ERROR_CHARS = 2_000
export const REASON_CHARS = 500
export const NOTE_CHARS = 2_000
const LOG_CHARS = 2_000
/** 失败时抄进日志的原文长度:够看出「它到底印了什么」,又不至于把会话原文抄进那份文件 */
export const LOG_SNIPPET_CHARS = 2_000

/** 这一条钩子这一次跑在哪一侧;只用于让钩子脚本知道自己有没有被关着,不是权限描述 */
export type HookBoundaryLabel = 'confined' | 'unrestricted' | 'none'

interface Clipped {
  text: string
  cut: boolean
}

function clip(text: string, max: number): Clipped {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= max) return { text: value, cut: false }
  return { text: value.slice(0, max), cut: true }
}

/**
 * 被切过的字段名。
 *
 * 每个截断处补一个 `xxxTruncated: true` 会让 data 里的键比正文还多,而钩子只需要知道
 * 「手里这份是不是完整的」—— 所以集中一个数组,列名而不是铺布尔值。
 */
function truncations(of: Record<string, Clipped>): string[] {
  return Object.entries(of)
    .filter(([, value]) => value.cut)
    .map(([key]) => key)
}

/** `beforeRequest` 之外的 data:每处截断都在 `truncated` 里点名 */
interface HookDataBase {
  [key: string]: unknown
}

/** 六个触发时机各自带的那一份上下文;判别式就是 `event`,所以 data 的形状由它唯一决定 */
export type HookTrigger =
  | { event: 'beforeAgent' }
  | {
      event: 'beforeRequest'
      step: number
      maxSteps: number
      isFinalStep: boolean
      tools: string[]
      messages: ChatCompletionMessage[]
    }
  | {
      event: 'afterRequest'
      step: number
      content: string
      reasoning: string
      calls: ToolCallRecord[]
      usage: TokenUsage | null
      model: string
    }
  | {
      event: 'beforeToolCall'
      step: number
      call: ToolCallRecord
      /** 参数解析不出来时是 null,而 `call.arguments` 里仍带着那串原文 —— 被模型写坏的调用也要看得见 */
      args: Record<string, unknown> | null
      workspaceRelative: string
    }
  | {
      event: 'afterToolCall'
      step: number
      call: ToolCallRecord
      ok: boolean
      result: string
      durationMs: number
    }
  | {
      event: 'afterAgent'
      /** 终局那一步的号;中止与模型报错时是「跑到这儿就停了」的那一步,正常收尾时是最后一步 */
      step: number
      finalContent: string
      aborted: boolean
      error: string
    }

export interface HookPayloadContext {
  hook: HookMeta
  scope: RunScope
  /** 本次会话的工作空间;未选择即空串 —— 一个是「我在哪儿」,一个是「我能写到哪儿」 */
  workspace: string
  boundary: HookBoundaryLabel
  /** 本轮要回应的那句话 */
  request: string
  /**
   * 这一步的额度上限,取自 loop 手里那份 run 配置。
   *
   * 它是 run 级事实,所以放在 context 而不是每个 trigger 里 —— 六个时机都要能回答
   * 「现在第几步、一共几步」,而 `beforeAgent` 的答案是「第 0 步,还没开始」。
   */
  maxSteps: number
  trigger: HookTrigger
}

export interface HookPayload {
  contract: number
  event: HookEvent
  hook: string
  dir: string
  run: {
    conversationId: string
    runId: string
    agent: string
    depth: number
    parentCallId: string
    step: number
    maxSteps: number
  }
  workspace: string
  boundary: HookBoundaryLabel
  request: string
  data: HookDataBase
}

/** 该事件此刻拿得到的那一步;`beforeAgent` 在任何一步之前触发,所以是 0 */
function stepOf(trigger: HookTrigger): number {
  return trigger.event === 'beforeAgent' ? 0 : trigger.step
}

/** 组装某一次触发的 stdin payload */
export function buildPayload(context: HookPayloadContext): HookPayload {
  const { hook, scope, trigger } = context
  const request = clip(context.request, REQUEST_CHARS)
  const data: HookDataBase = {}
  const clipped: Record<string, Clipped> = {}

  if (trigger.event === 'beforeAgent') {
    // 空 data:此刻还没有任何出站请求(第一份在第 1 步的 planContext 之后才成型),
    // 所以这个时机只有说明与否决可用 —— 不是漏了字段,是这个时机确实没有内容可给。
  } else if (trigger.event === 'beforeRequest') {
    data.step = trigger.step
    data.maxSteps = trigger.maxSteps
    data.isFinalStep = trigger.isFinalStep
    // 只给名字:工具定义是几百上千行的 JSON,而钩子要知道的是「这一步模型有哪些工具可选」
    data.tools = trigger.tools
    // **整份出站消息数组,原文不截断不重排**:这是本契约唯一给出去又能收回来的那一段
    data.messages = trigger.messages
  } else if (trigger.event === 'afterRequest') {
    clipped.content = clip(trigger.content, CONTENT_CHARS)
    clipped.reasoning = clip(trigger.reasoning, REASONING_CHARS)
    data.content = clipped.content.text
    data.reasoning = clipped.reasoning.text
    data.calls = trigger.calls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: clip(call.arguments, ARGUMENTS_CHARS).text
    }))
    if (trigger.calls.some((call) => call.arguments.length > ARGUMENTS_CHARS)) {
      clipped.calls = { text: '', cut: true }
    }
    data.usage = trigger.usage
    data.model = trigger.model
  } else if (trigger.event === 'beforeToolCall') {
    clipped.arguments = clip(trigger.call.arguments, ARGUMENTS_CHARS)
    data.call = {
      id: trigger.call.id,
      name: trigger.call.name,
      arguments: clipped.arguments.text
    }
    data.args = trigger.args
    data.workspaceRelative = trigger.workspaceRelative
  } else if (trigger.event === 'afterToolCall') {
    clipped.arguments = clip(trigger.call.arguments, ARGUMENTS_CHARS)
    clipped.result = clip(trigger.result, RESULT_CHARS)
    data.call = {
      id: trigger.call.id,
      name: trigger.call.name,
      arguments: clipped.arguments.text
    }
    data.ok = trigger.ok
    data.result = clipped.result.text
    data.durationMs = trigger.durationMs
  } else {
    clipped.finalContent = clip(trigger.finalContent, CONTENT_CHARS)
    clipped.error = clip(trigger.error, ERROR_CHARS)
    data.finalContent = clipped.finalContent.text
    data.aborted = trigger.aborted
    data.error = clipped.error.text
  }

  const names = truncations(clipped)
  if (request.cut) names.push('request')
  if (names.length > 0) data.truncated = names

  return {
    contract: HOOK_CONTRACT_VERSION,
    event: hook.event,
    hook: hook.name,
    dir: hook.dir,
    run: {
      conversationId: scope.conversationId,
      runId: scope.runId,
      agent: scope.agent,
      depth: scope.depth,
      parentCallId: scope.parentCallId,
      step: stepOf(trigger),
      maxSteps: context.maxSteps
    },
    workspace: context.workspace,
    boundary: context.boundary,
    request: request.text,
    data
  }
}

export interface SerializedPayload {
  json: string
  bytes: number
  tooLarge: boolean
}

/**
 * 序列化并量一次尺寸。
 *
 * 超限**不截断**:一段被切的 JSON 让钩子拿到的是坏输入,而它多半会把坏输入当成
 * 「没有结论」再原样回一份 —— 白跑一个进程。跳过这一条、把理由写进日志才是实话。
 */
export function serializePayload(payload: HookPayload): SerializedPayload {
  const json = JSON.stringify(payload)
  const bytes = Buffer.byteLength(json, 'utf8')
  return { json, bytes, tooLarge: bytes > MAX_HOOK_PAYLOAD_BYTES }
}

export interface ResolvedCommand {
  /** 交给 spawn 的完整 argv:第 0 项是可执行文件,后面原样是参数 */
  argv: string[]
  /** 解析后的绝对路径;裸命令名(按 PATH 查找)时是空串,界面据此决定要不要写「PATH 查找」 */
  file: string
  /** 进程的工作目录:恒为钩子目录 */
  cwd: string
}

/**
 * 含路径分隔符、以 `.` / `..` / `~` / 盘符开头、**或带扩展名**的 `command` 按钩子目录解析,其余按 PATH 查找。
 *
 * 「带扩展名」那一支是必须的:`command: hook.mjs` 指的就是这条钩子自己目录里的那个文件
 * (与 `./hook.mjs` 同义),因为脚本跟着声明放在旁边才是能读懂的形状。
 * 代价要写清:**名字里真的有点的 PATH 程序**(如 `pip3.11`)会被当成文件而不是命令名,
 * 那一台机器上要写绝对路径 —— 失败只有一行 `spawn-error` 日志,所以界面上那颗输入框的
 * 说明必须把这条规则原样抄过去,不能省。
 *
 * 三条派生的实话:
 * ① 声明了 `sandboxed` 的钩子写不到自己这个目录 —— 钩子目录在工作空间之外,那道边界只放开
 *    工作空间与临时目录,所以它要落盘就写 payload 里的 `workspace` 或 `$TMPDIR`;
 * ② 受限那一支的环境是白名单,裸命令名能否找到取决于**那份 PATH**,不是宿主机的完整 PATH;
 * ③ Windows 上不经 shell 不解析 `.bat` / `.cmd`,那一台上要指 `.exe` 或绝对路径。
 */
export function resolveHookCommand(hook: HookMeta): ResolvedCommand {
  const declared = hook.command
  const expanded = expandHome(declared)
  const base = declared.split(/[/\\]/).pop() ?? declared
  const isPath =
    declared.includes('/') ||
    declared.includes('\\') ||
    declared.startsWith('~') ||
    /^[a-zA-Z]:[\\/]/.test(declared) ||
    // 带点的最后一段当作文件名;`python3` / `git` / `node` 这些没有点,仍然按命令名走 PATH
    base.includes('.')
  const file = isPath ? path.resolve(hook.dir, expanded) : ''
  return {
    argv: [file || declared, ...hook.args],
    file,
    cwd: hook.dir
  }
}

/** 没有结论时的那一份回执:`problem` 非空即「这次什么都不是」 */
function noDecision(problem: string, exitCode: number | null, raw = ''): HookReply {
  return {
    block: false,
    reason: '',
    note: '',
    rewrite: null,
    log: '',
    ignored: [],
    problem,
    exitCode,
    out: clip(raw, LOG_SNIPPET_CHARS).text
  }
}

function asOptionalText(value: unknown, field: string, max: number): Clipped {
  if (value === undefined || value === null) return { text: '', cut: false }
  if (typeof value !== 'string') throw new TypeError(`${field} 要是字符串`)
  return clip(value, max)
}

/**
 * 读 stdout 上那段 JSON,合成这一次触发的结论。
 *
 * 判定表(全在这一个函数里,`runner.ts` 只管起进程与收字节):
 *
 * | 情形 | 结论 |
 * |---|---|
 * | 合法 JSON | 照它 |
 * | 不可解析 / 空 / 超上限 | 无决策 |
 * | 退出码非 0 且 stdout 可解析 | **照它**(退出码表达失败、stdout 表达理由) |
 *
 * 方向性原则是**否决与改写失败即放行**:写错的 `command` 不该把整轮工具调用团住,
 * 也不该把一份没验过的数组送进端点。边界那侧相反(fail-closed),那张表在 `boundary.ts`。
 *
 * `overflow` 由调用方给:`BufferSink` 越上限时整段作废,所以这里读到的是空串,
 * 而「空串」与「钩子什么都没输出」是两件事,得靠这一个标志分开。
 */
export function readReply(
  stdout: string,
  stderr: string,
  event: HookEvent,
  options: { exitCode?: number | null; overflow?: boolean } = {}
): HookReply {
  const exitCode = options.exitCode ?? null
  const failed = exitCode !== null && exitCode !== 0
  if (options.overflow) {
    const limit = event === 'beforeRequest' ? MAX_REWRITE_REPLY_BYTES : MAX_HOOK_REPLY_BYTES
    return noDecision(`输出超过 ${limit} 字节上限,整段作废`, exitCode)
  }
  const text = stdout.trim()
  if (text === '') {
    return noDecision(
      failed ? `退出码 ${String(exitCode)} 且没有输出` : '没有输出',
      exitCode,
      stderr
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return noDecision(
      `输出不是合法的 JSON:${error instanceof Error ? error.message : String(error)}`,
      exitCode,
      stdout
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return noDecision('输出的 JSON 不是一个对象', exitCode, stdout)
  }
  const reply = parsed as Record<string, unknown>
  const ignored: string[] = []
  const before = event.startsWith('before')

  let block = false
  if (reply.block !== undefined && reply.block !== null) {
    if (before) {
      // 只有 === true 才算否决:字符串 "false"、数字 1 都读成「不拦」,
      // 因为把「没说拦」读成「拦」会让一个写歪的字段把整轮团住
      block = reply.block === true
    } else ignored.push('block')
  }

  let reason = ''
  if (reply.reason !== undefined && reply.reason !== null) {
    if (before) {
      try {
        reason = asOptionalText(reply.reason, 'reason', REASON_CHARS).text
      } catch {
        ignored.push('reason')
      }
    } else ignored.push('reason')
  }

  let note = ''
  if (reply.note !== undefined && reply.note !== null) {
    try {
      note = asOptionalText(reply.note, 'note', NOTE_CHARS).text
    } catch {
      ignored.push('note')
    }
  }

  let rewrite: unknown[] | null = null
  if (reply.messages !== undefined && reply.messages !== null) {
    if (event === 'beforeRequest') {
      if (Array.isArray(reply.messages)) rewrite = reply.messages
      else ignored.push('messages')
    } else ignored.push('messages')
  }

  let log = ''
  if (reply.message !== undefined && reply.message !== null) {
    try {
      log = asOptionalText(reply.message, 'message', LOG_CHARS).text
    } catch {
      ignored.push('message')
    }
  }

  return {
    block,
    reason,
    note,
    rewrite,
    log,
    ignored,
    problem: '',
    exitCode,
    // 退出码非 0 但回执可用时,stderr 是「它自己认为哪儿出了错」的唯一线索,值得留在日志里
    out: failed ? clip(stderr, LOG_SNIPPET_CHARS).text : ''
  }
}

/** 工具事件上那次否决给模型看的那句;陈述句、点名钩子、不含祈使 */
export function describeToolBlock(hookName: string, reason: string): string {
  return reason
    ? `[被钩子 ${hookName} 拦下:${reason}]`
    : `[被钩子 ${hookName} 拦下,这次调用没有执行]`
}

/** run 级否决(改本轮收场)给模型与界面看的那句 */
export function describeRunBlock(hookName: string, reason: string): string {
  return reason ? `[被钩子 ${hookName} 拦下:${reason}]` : `[被钩子 ${hookName} 拦下,本轮没有继续]`
}
