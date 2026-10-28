import { runProcess } from '../process/spawn'
import { BufferSink } from '../process/sink'
import {
  LOG_SNIPPET_CHARS,
  MAX_HOOK_PAYLOAD_BYTES,
  MAX_HOOK_REPLY_BYTES,
  MAX_REWRITE_REPLY_BYTES,
  readReply,
  resolveHookCommand,
  serializePayload
} from './contract'
import type { HookPayload } from './contract'
import type { HookDecision, HookExecution, HookFailure } from './dto'
import { recordHook } from './log'
import type { HookBoundary } from './boundary'
import type { HookMeta, HookReply } from './types'

/**
 * 起一个钩子进程、读它的回执、落一行日志 —— 一次触发一件事实。
 *
 * **永不抛、永不 reject**:钩子是用户自己写的程序,它坏了、起不来、超时、印一堆非 JSON,
 * 都不该把模型的一次正常调用改成失败,也不该把一轮 run 停在观测面上。方向与审批那道闸门
 * 相反,是**否决与改写失败即放行**:写错的 `command` 不该把整轮工具调用团住。
 * 只有边界那一侧才是 fail-closed(那张表在 `boundary.ts`)。
 *
 * 三条与 `run_command` 不同的形状,都落在 `ProcSpec` 的可选字段上(见 process/types.ts):
 * ① `argv` —— 钩子的命令**不经过 shell**,参数不会被二次分词,也没有引号陷阱;
 * ② `stdin` —— payload 走这根管道,而不是命令行参数或环境变量(长度与可见性都有问题);
 * ③ `BufferSink` —— 要的是「原始 stdout,要么完整要么作废」:`MergedSink` 那种从中间挖洞的
 * 裁剪会把一份 JSON 劈成解析不了的半截,而它的 `[stderr] ` 前缀会直接把这份 JSON 弄脏。
 *
 * 这一层不认识 electron、DB 与 loop:payload 由 `contract.ts` 组好交进来,
 * 「这份回执算什么处置」由调用方的 `apply` 说了算,这里只管起进程、读回执、记一行。
 */

/** 一次有结论的回执被处置成什么;除 `decision` 之外只带界面要展示的几格 */
export interface HookDisposition {
  decision: HookDecision
  failure?: HookFailure
  /** 追加进日志的本地说明(说明被丢掉、改写没过守卫),与钩子自己写的那句拼在一起 */
  log?: string
  rewritten?: boolean
  msgCount?: number
}

export interface HookRunOptions {
  /** `boundaryOf` 的结论;`skip` 那一支在这里落一行 `skipped` 后收场,一个进程都不起 */
  boundary: HookBoundary
  signal: AbortSignal
  /**
   * 调用方怎么处置这份回执 —— 同时**由它落定这一次触发算哪种处置**。
   *
   * 只有调用方知道自己怎么用了它:那条说明进没进本步的缓冲区(满了会被丢掉)、那份改写有没有
   * 过 `guard.ts` 的五步。判定交回调用方、写行留在这一层,为的是让「一次触发恰好一行」
   * 只由**一个函数**负责:两处写日志,就有一处会漏一行。
   *
   * 它可以抛 —— 抛了就走本层的外兜:那一行按 `failed` 记,返回的回执 `problem` 非空,
   * 于是调用方**不会拦下任何东西**。这就是「否决失败即放行」在本层的落点。
   */
  apply: (reply: HookReply) => HookDisposition
}

/** 没有任何结论时的那份回执:调用方据 `problem` 非空决定「这次什么都不是」 */
function noReply(problem: string): HookReply {
  return {
    block: false,
    reason: '',
    note: '',
    rewrite: null,
    log: '',
    ignored: [],
    problem,
    exitCode: null,
    out: ''
  }
}

function snippet(text: string): string {
  return text.length > LOG_SNIPPET_CHARS ? text.slice(0, LOG_SNIPPET_CHARS) : text
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 落一行:骨架 + 这一次特有的那几格。
 *
 * 骨架的字段全部来自 payload —— payload 就是这一次触发的事实,而日志是它的一份投影;
 * 两处各读各的就会出现「日志里的步号与钩子看到的步号不一致」这种查不清的事。
 * `recordHook` 自己不抛,所以这一层不需要为写盘失败写分支。
 */
async function record(
  payload: HookPayload,
  patch: Partial<HookExecution> & { decision: HookDecision },
  ms: number,
  reply?: HookReply
): Promise<void> {
  const notes = [patch.log, reply?.log].filter((one): one is string => Boolean(one))
  const row: HookExecution = {
    ts: new Date().toISOString(),
    event: payload.event,
    hook: payload.hook,
    conversationId: payload.run.conversationId,
    runId: payload.run.runId,
    agent: payload.run.agent,
    depth: payload.run.depth,
    step: payload.run.step,
    decision: patch.decision,
    ms,
    reason: reply?.reason || undefined,
    note: reply?.note || undefined,
    ignored: reply && reply.ignored.length > 0 ? reply.ignored : undefined,
    log: notes.join('\n') || undefined,
    failure: patch.failure,
    // 非 0 退出码只要出现过就留:合法回执那一支的 `patch` 不带它,而「它自己退得非 0」
    // 是读那行的人唯一能分清「它崩了」与「它按约定回了话」的线索
    exit:
      patch.exit ??
      (reply && reply.exitCode !== null && reply.exitCode !== 0 ? reply.exitCode : undefined),
    out: patch.out,
    err: patch.err,
    why: patch.why,
    rewritten: patch.rewritten,
    msgCount: patch.msgCount
  }
  await recordHook(row)
}

async function settle(
  hook: HookMeta,
  payload: HookPayload,
  options: HookRunOptions,
  startedAt: number
): Promise<HookReply> {
  if (options.boundary.mode === 'skip') {
    // 一个进程都不起:声明了 `sandboxed` 的钩子要的是「别让它写到外面去」,而这里建不出边界 ——
    // 退回不受限地跑一遍恰好违背它的意图(所以 boundary.ts 的表里根本没有那一支)
    await record(
      payload,
      { decision: 'skipped', failure: 'no-boundary', why: options.boundary.why },
      0
    )
    return noReply('没有可用的边界,这一次没有运行')
  }

  const serialized = serializePayload(payload)
  if (serialized.tooLarge) {
    // 超限不截断:半截 JSON 让钩子拿到坏输入,而它多半会把坏输入当成「没有结论」原样回一份 ——
    // 白跑一个进程。跳过这一条并写明尺寸才是实话
    await record(
      payload,
      {
        decision: 'skipped',
        failure: 'payload-too-large',
        why: `这一次触发的载荷有 ${String(serialized.bytes)} 字节,超过 ${String(MAX_HOOK_PAYLOAD_BYTES)} 的上限,没有送进管道`
      },
      0
    )
    return noReply('载荷超过上限,这一次没有运行')
  }

  // 命令串只是给人看的:argv 那一支不会拿它拼载荷(见 spawnProc 的第三支)
  const command = [hook.command, ...hook.args].join(' ')
  // `beforeRequest` 要回整份改写后的出站消息,正常就有 MB 级,所以用宽的那条上限读它
  const cap = hook.event === 'beforeRequest' ? MAX_REWRITE_REPLY_BYTES : MAX_HOOK_REPLY_BYTES
  const sink = new BufferSink(cap)
  const outcome = await runProcess({
    command,
    cwd: payload.dir,
    argv: resolveHookCommand(hook).argv,
    stdin: serialized.json,
    timeoutMs: hook.timeoutMs,
    signal: options.signal,
    // 不受限那一支是 undefined,于是继承 process.env:通知类钩子真的需要 HOME 与会话变量
    launch: options.boundary.launch,
    sink
  })
  const ms = Date.now() - startedAt

  if (outcome.kind === 'spawn-error') {
    // ENOENT 只在这条路上看得见(命令写错目录是最常见的一种),所以把中文化那句抄进日志
    await record(
      payload,
      { decision: 'failed', failure: 'spawn-error', err: snippet(outcome.spawnError) },
      ms
    )
    return noReply(`命令起不来:${outcome.spawnError}`)
  }
  if (outcome.kind === 'timeout') {
    await record(
      payload,
      {
        decision: 'failed',
        failure: 'timeout',
        err: snippet(sink.stderr),
        log: `超过 ${String(hook.timeoutMs)} 毫秒没有给出结论,这一次按没有结论处理`
      },
      ms
    )
    return noReply(`钩子进程在 ${String(hook.timeoutMs)} 毫秒内没有结束`)
  }
  if (outcome.kind === 'aborted') {
    // 中止先于启动时 `runProcess` 根本不 spawn,所以这一支不会有半截进程
    await record(payload, { decision: 'failed', failure: 'aborted' }, ms)
    return noReply('本轮已中止,这一次触发没有结论')
  }

  const reply = readReply(sink.stdout, sink.stderr, hook.event, {
    exitCode: outcome.code,
    overflow: sink.overflow
  })
  if (reply.problem !== '') {
    // 非 0 退出码 + 解析不了:两格都留,读的人才能分清「它崩了」与「它印了别的东西」
    await record(
      payload,
      {
        decision: 'failed',
        failure: 'bad-output',
        out: reply.out,
        err: snippet(sink.stderr),
        exit: outcome.code !== 0 ? outcome.code : undefined
      },
      ms
    )
    return reply
  }

  await record(payload, options.apply(reply), ms, reply)
  return reply
}

export async function runHook(
  hook: HookMeta,
  payload: HookPayload,
  options: HookRunOptions
): Promise<HookReply> {
  const startedAt = Date.now()
  try {
    return await settle(hook, payload, options, startedAt)
  } catch (error) {
    // 到这里只剩两种事:本层自己的意外,或调用方那份 `apply` 抛了。两种都按「没有结论」收场,
    // 于是**没有任何东西被拦下** —— 一个 bug 不该替用户否决一次操作
    const problem = `这一次触发出了意外:${message(error)}`
    try {
      await record(
        payload,
        { decision: 'failed', failure: 'bad-output', err: snippet(problem) },
        Date.now() - startedAt
      )
    } catch {
      // recordHook 自己不抛;这一层只是保证兜底本身不会把 reject 传回去
    }
    return noReply(problem)
  }
}
