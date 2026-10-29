import path from 'node:path'
import type { RunScope, TokenUsage, ToolCallRecord } from '../chat/dto'
import type { ChatCompletionMessage } from '../chat/llm'
import type { ToolContext } from '../tools/registry'
import { anchor } from '../tools/paths'
import type { SandboxSettings } from '../store/types'
import { boundaryOf } from './boundary'
import type { HookPayload, HookTrigger } from './contract'
import { MAX_NOTES_PER_STEP, buildPayload, describeRunBlock, describeToolBlock } from './contract'
import { acceptRewrite } from './guard'
import type { HookEvent, HookMeta, HookReply } from './types'
import { matcherApplies, matchesHook } from './matcher'
import { runHook } from './runner'
import type { HookDisposition, HookRunOptions } from './runner'

/**
 * 一次 run 的钩子编排:哪些钩子该为这一刻跑、跑完的东西去哪儿。
 *
 * 这一层单独存在(而不是把这一切塞进 `chat/hook.ts` 或 loop)有三个理由:
 * ① **一份说明缓冲区只能有一个持有者**。`beforeAgent` 与 `beforeToolCall` 的说明最终都进
 * 下一步请求的同一段,分两处攒就会出现「谁先谁后说不清」;
 * ② 派发规则(按名字排序、串行、第一个否决之后就停)是**能被断言的**东西,而装饰器与 loop
 * 都要 electron 与 DB 才跑得起来,规则放在这里才能脱离应用验证;
 * ③ 子 Agent 与主 Agent 走的是**同一个调用**(`forRun` 一次拿到两份半边),
 * 「子 run 绕开钩子」这条路从结构上不存在 —— 与审批闸门那条纪律同源。
 */

/** 一次触发要落到的那一步的说明缓冲区;`takeNotes` 取完即清,所以它的粒度天然是「一步」 */
export interface HookRun {
  /** 四个 run 级事件 + 说明缓冲区,由 service 交给 loop 作 `RunAgentParams.hooks` */
  runHooks: RunHooks
  /** 两个工具事件的那一半,交给 `chat/hook.ts` 的装饰器 */
  toolDeps: ToolHookDeps
}

export interface ToolCallTarget {
  call: ToolCallRecord
  /** 参数解析不出来即 null;那次调用也要被看见,所以原文仍随 `call.arguments` 一起给 */
  args: Record<string, unknown> | null
  /** 第几步;`ToolContext` 带,装饰器不必再问 loop */
  step: number
}

export interface ToolHookDeps {
  /** 否决时给模型看的那句话;不否决即 undefined */
  beforeToolCall(target: ToolCallTarget): Promise<string | undefined>
  /** 事后只能追加说明,所以没有返回值:那次调用已经真的发生过了 */
  afterToolCall(
    target: ToolCallTarget & { ok: boolean; result: string; durationMs: number }
  ): Promise<void>
}

/**
 * `beforeRequest` 看到的那一次请求。
 *
 * 落位是**裁剪之后**:那时候数组才定型,钩子改的才是真的即将发出去的那一份字节。放在裁剪之前
 * 给它的是还没定型的原料,改完照样要被裁一遍,等于让它对着一份假快照动手。
 *
 * `fixed` / `pinned` / `pinnedOf` 是只有 loop 知道的三件事,守卫与改写都要用:
 * 头部那几条不许动、尾部那几条不许动,而尾部要能带着本步新增的说明重拼。
 * 重拼的方法留在 loop(说明排在目标锚定**之前**是那边的规则),这一层只调用、不假设。
 */
export interface BeforeRequestContext {
  step: number
  maxSteps: number
  isFinalStep: boolean
  /** 只给名字:工具定义是几百上千行 JSON,而钩子要知道的是「这一步有哪些可选」 */
  tools: string[]
  /** 固定头部(系统提示 + 摘要块)的条数 */
  fixed: number
  /** 本步的循环控制消息:收尾提示 + 已贴的说明 + 目标锚定 */
  pinned: ChatCompletionMessage[]
  /** `planContext` 刚返回、正准备发出去的那一份 */
  messages: ChatCompletionMessage[]
  /** 用「本步新增的说明」重拼一次尾部 */
  pinnedOf(notes: string[]): ChatCompletionMessage[]
}

/**
 * 一次 `beforeRequest` 链的产出。三样各归各处:
 * `block` 让本轮收场,`history` 与 `notes` 让 loop 重裁一次再发。
 */
export interface BeforeRequestOutcome {
  /** 否决那句:这次请求不发了;没有否决即 undefined */
  block?: string
  /** 过了守卫的新中段(不含头部与尾部);没有任何改写成功即 null */
  history: ChatCompletionMessage[] | null
  /** 本批钩子追加的说明,由 loop 拼进本步的 `pinned` */
  notes: string[]
}

/**
 * `afterRequest` 看到的那一步。
 *
 * `usage` 与 `model` 是 loop 手里那份事实的原样转出:钩子要做的是「这一步花多少、答了什么」的
 * 记账与提醒,而不是自己再去估一遍 —— 两处各估一份就会有两个数,而用户看不出哪个是真的。
 */
export interface AfterRequestContext {
  step: number
  content: string
  reasoning: string
  calls: ToolCallRecord[]
  usage: TokenUsage | null
  /** 这一步是不是被停止打断的:中止时 `calls` 已被清空,光看数组分不清「没调用」与「没来得及」 */
  aborted: boolean
  model: string
}

/**
 * `afterAgent` 看到的那一句终局。四条出口各一次,所以这里的 `step` 是「跑到哪儿就停了」:
 * 正常收尾是最后一步,中止是打断那一步,模型报错是出错那一步。
 */
export interface FinishContext {
  step: number
  finalContent: string
  aborted: boolean
  /** 空串即不是报错(中止与正常收尾都没有这一句) */
  error: string
}

/**
 * 交给 loop 的那一半:`RunAgentParams.hooks`。
 *
 * 四个方法都是 `Promise<void>` 或带回一份决定,**没有一条会抛** —— 钩子是用户自己写的程序,
 * 它坏了、起不来、超时都不该把模型的一次正常调用改成失败(方向与边界那侧的 fail-closed 相反)。
 */
export interface RunHooks {
  /**
   * 一次 run 只在最开头触发一次,在任何一步、任何一行入库之前。
   *
   * 它的说明是**常驻**的:整个 run 每一步都贴进请求,所以「跑之前提醒模型一句」这类用法
   * 不需要每步重复。否决写在 `blocked` 上而不是返回值 —— 它是这一轮的终局,而 loop 要在
   * 整个 run 的任何一处都能读到同一个结论。
   */
  beforeAgent(): Promise<void>
  /**
   * 每一步在请求成型之后、发出去之前问一次(`once` 的钩子只在第 1 步问)。
   *
   * 这是六个时机里唯一「给出去又能收回来」的一段:钩子能看到整份出站消息并回一份新的,
   * 而那份新的**必须先过 `guard.ts` 的五步**才作数 —— 那是全项目唯一一处运行时校验,
   * 因为从这一刻起,输入的字节不再是我们自己构造的了。
   */
  beforeRequest(context: BeforeRequestContext): Promise<BeforeRequestOutcome>
  afterRequest(context: AfterRequestContext): Promise<void>
  afterAgent(context: FinishContext): Promise<void>
  /**
   * 本步要贴进请求的说明:先整个 run 常驻的那批(`beforeAgent`),后本步新攒的(两个工具事件与 `afterRequest`)。
   *
   * 取完即清,所以 loop 每步现取一次;顺序由这里定,拼在目标锚定**之前** ——
   * 锚定靠「近期性」起作用,排在它后面才不破坏那条既有不变量。
   * `beforeRequest` 的说明不从这条路走(它属于**这一步**,而这里交出去的是给下一次请求的),
   * 它跟着那份改写的返回值一起交回 loop,见 `BeforeRequestOutcome.notes`。
   */
  takeNotes(): string[]
  /** `beforeAgent` 的否决结论;没有否决即 undefined。非空即本轮不开始 */
  blocked?: string
}

/** 一次 run 的事实,`forRun` 之后随整轮固定 —— 与 `workspace` / 审批名单同一条快照纪律 */
export interface HookRunContext {
  scope: RunScope
  workspace: string
  /** 与 `run_command` 同一份快照里的同一个对象:不重算边界,只翻结论 */
  jail: ToolContext['jail']
  /** `settings.sandbox`:没有工作空间时要用它把「沙箱被关掉」与「这条会话没选目录」分开 */
  sandbox: SandboxSettings | undefined
  signal: AbortSignal
  /** 本轮要回应的那句话:payload 里每个事件都带,而它一次 run 内不变 */
  request: string
  maxSteps: number
}

export interface HookSetDeps {
  /**
   * 一次触发的执行体。
   *
   * 默认是真那份(`runner.ts`,会起进程);单测传一个假的进来,于是「串行、按名排序、
   * 第一个否决后不再问、说明进缓冲区」这些规则不需要真起进程就能断言。
   */
  run?: HookExecutor
}

/** 与 `runner.ts` 的 `runHook` 同一个签名 —— 这一层只认它,不认 child_process */
type HookExecutor = (
  hook: HookMeta,
  payload: HookPayload,
  options: HookRunOptions
) => Promise<HookReply>

/** 同名的两条不会同时存在(目录名即身份),所以按名字排就是按磁盘上的稳定顺序排 */
function byName(a: HookMeta, b: HookMeta): number {
  return a.name.localeCompare(b.name)
}

/**
 * 一条说明落去哪儿,以及那个位置此刻已经占了几条。
 *
 * 三个落点的「已知部分」各不相同 —— 下一步那批只看常驻与已攒的,本步那批还要算上已经拼进
 * `pinned` 的,常驻那批只看它自己。基数由各处现给,因为上限量的量是**一份请求里有几条说明**,
 * 而不是「有几个缓冲区」。少算哪一处都会让一次请求带上超过 `MAX_NOTES_PER_STEP` 条说明。
 */
interface NoteSink {
  add(note: string): void
  used(): number
}

/**
 * 这一次调用「算不算这条钩子管的」。
 *
 * 参数解析不出来时按**空对象**比对(与 `matcher.ts` 里 `HookMatchTarget` 的约定一致):
 * 拦 `git push` 的钩子在一串坏 JSON 上开不开口?开不了,因为那时根本读不出命令 ——
 * 而这条调用马上就会被内层工具拒掉(参数不是合法 JSON),拦它也没有意义。
 */
function covers(
  hook: HookMeta,
  call: ToolCallRecord,
  args: Record<string, unknown> | null
): boolean {
  if (!matcherApplies(hook.event)) return true
  return matchesHook(hook.matcher, { toolName: call.name, args: args ?? {} })
}

/** 相对工作空间的那条路径:payload 里给钩子看的是「它在管哪个文件」,不是模型写下的那串字形 */
function workspaceRelative(args: Record<string, unknown> | null, workspace: string): string {
  const trimmed = workspace.trim()
  const raw = args && typeof args.path === 'string' ? args.path.trim() : ''
  if (!trimmed || !raw) return ''
  return path.relative(trimmed, anchor(raw, trimmed).path)
}

/** 一份声明快照的钩子集合:`forRun` 每次 run 现调,派发规则共用同一份分桶结果 */
export interface HookSet {
  forRun(context: HookRunContext): HookRun
}

export function createHookSet(hooks: HookMeta[], deps: HookSetDeps = {}): HookSet {
  const execute = deps.run ?? runHook
  // 声明快照只读一次,所以按事件分桶 + 排序放在这里:每次触发都排一遍等于把顺序交给运气
  const byEvent = new Map<HookEvent, HookMeta[]>()
  for (const hook of [...hooks].sort(byName)) {
    const list = byEvent.get(hook.event)
    if (list) list.push(hook)
    else byEvent.set(hook.event, [hook])
  }

  return {
    forRun(context: HookRunContext): HookRun {
      const { scope, workspace, jail, sandbox, signal, request, maxSteps } = context
      // `beforeAgent` 那一批:整个 run 每一步都贴,所以它和「本步新增」分开装
      const sticky: string[] = []
      // 下一步要贴的说明。上限在这里挡,不在界面或 loop 挡:一个碎嘴的钩子不该把
      // planContext 推进缩写档,开始裁真正的工具结果
      const pending: string[] = []
      // `takeNotes()` 本步已经贴出去几条(不含常驻那批)。`beforeRequest` 的说明直接进**这一步**
      // 的请求、不进 `pending`,所以那份额度要把已经贴出去的也算进来,而不是只看缓冲区里还剩几个位置
      let handed = 0

      /** 说明进 `pending`:那一批是给下一次请求的 */
      const pendingSink: NoteSink = {
        add: (note) => pending.push(note),
        used: () => sticky.length + pending.length
      }
      /** 说明进 `sticky`:整个 run 从此每一步都带着它 */
      const stickySink: NoteSink = {
        add: (note) => sticky.push(note),
        used: () => sticky.length + pending.length
      }

      /** 一份回执落地:说明进对应的缓冲区,否决由调用方读 `reply.block` 自己处理 */
      const noteDisposition =
        (sink: NoteSink) =>
        (hook: HookMeta, reply: HookReply): HookDisposition => {
          if (reply.block) return { decision: 'blocked' }
          if (reply.note === '') return { decision: 'noop' }
          if (sink.used() >= MAX_NOTES_PER_STEP) {
            return {
              decision: 'noop',
              log: `本步的说明已达 ${String(MAX_NOTES_PER_STEP)} 条上限,${hook.name} 这一条被丢掉`
            }
          }
          sink.add(reply.note)
          return { decision: 'adopted' }
        }

      const fire = async (
        hook: HookMeta,
        trigger: HookTrigger,
        settle: (hook: HookMeta, reply: HookReply) => HookDisposition
      ): Promise<HookReply> => {
        const boundary = boundaryOf(hook, jail, sandbox, workspace)
        const payload = buildPayload({
          hook,
          scope,
          workspace,
          // 跳过那一支根本没运行,payload 也永远不会被读走;写 'none' 是为了让那一行的
          // `boundary` 说的仍是实话(此刻确实没有任何边界装着它)
          boundary: boundary.mode === 'run' ? boundary.boundary : 'none',
          request,
          maxSteps,
          trigger
        })
        return execute(hook, payload, {
          boundary,
          signal,
          apply: (reply) => settle(hook, reply)
        })
      }

      const noteSettler = noteDisposition(pendingSink)

      const runHooks: RunHooks = {
        async beforeAgent() {
          const settle = noteDisposition(stickySink)
          for (const hook of byEvent.get('beforeAgent') ?? []) {
            const reply = await fire(hook, { event: 'beforeAgent' }, settle)
            if (reply.block) {
              // 后面的钩子不再问:这一轮已经不开始了,再问一遍不会带来新信息
              runHooks.blocked = describeRunBlock(hook.name, reply.reason)
              return
            }
          }
        },

        async beforeRequest(c: BeforeRequestContext): Promise<BeforeRequestOutcome> {
          // 本步新增的说明:它们不进 `pending`(那一批是给下一次请求的),而是跟着返回值一起
          // 交回 loop,拼进**这一步**的 `pinned`
          const extra: string[] = []
          const sink: NoteSink = {
            add: (note) => extra.push(note),
            used: () => sticky.length + handed + extra.length
          }
          const settle = noteDisposition(sink)
          const outcome: BeforeRequestOutcome = { history: null, notes: extra }
          // 链式:后一条钩子拿到前一条改完、追加完说明的那一份,守卫在每一次交接上各跑一遍。
          // 头与尾分开放,是为了每一次交接都能重拼出「此刻真的准备发出去的那一份」
          const head = c.messages.slice(0, c.fixed)
          let middle = c.messages.slice(c.fixed, c.messages.length - c.pinned.length)
          let pinned = c.pinned
          let working = c.messages
          /** 用此刻的中段与本步说明重拼;`pinnedOf([])` 与原本那份相同,所以对没动的链是空操作 */
          const reshape = (): void => {
            pinned = c.pinnedOf(extra)
            working = [...head, ...middle, ...pinned]
          }

          for (const hook of byEvent.get('beforeRequest') ?? []) {
            // `once` 的钩子只在第 1 步问:注入型改写每步再问一遍,只是把同一份数组多过一次守卫
            if (hook.once && c.step > 1) continue
            const original = working
            const originalPinned = pinned
            const reply = await fire(
              hook,
              {
                event: 'beforeRequest',
                step: c.step,
                maxSteps: c.maxSteps,
                isFinalStep: c.isFinalStep,
                tools: c.tools,
                messages: original
              },
              (h, r) => {
                const notes = settle(h, r)
                if (notes.decision === 'blocked' || r.rewrite === null) return notes
                const verdict = acceptRewrite({
                  incoming: r.rewrite,
                  original,
                  fixed: c.fixed,
                  pinned: originalPinned
                })
                if (!verdict.accepted) {
                  // 整份改写作废、回落原本那一份:外部程序改坏一个字节不该由端点来发现,
                  // 而那次作废只说明这份改写没采纳,前面已经采纳的说明照旧算数
                  return {
                    ...notes,
                    decision: 'rejected',
                    failure: 'rewrite-rejected',
                    rewritten: false,
                    log:
                      notes.log === undefined ? verdict.reason : `${notes.log}\n${verdict.reason}`
                  }
                }
                middle = verdict.history
                outcome.history = middle
                reshape()
                return { ...notes, decision: 'adopted', rewritten: true, msgCount: working.length }
              }
            )
            if (reply.block) {
              // 否决优先于改写:这次请求根本不发了,改得再好也没有收件人
              outcome.block = describeRunBlock(hook.name, reply.reason)
              return outcome
            }
            reshape()
          }
          return outcome
        },

        async afterRequest({ step, content, reasoning, calls, usage, aborted, model }) {
          for (const hook of byEvent.get('afterRequest') ?? []) {
            await fire(
              hook,
              { event: 'afterRequest', step, content, reasoning, calls, usage, aborted, model },
              noteSettler
            )
          }
        },

        async afterAgent({ step, finalContent, aborted, error }) {
          try {
            for (const hook of byEvent.get('afterAgent') ?? []) {
              await fire(
                hook,
                { event: 'afterAgent', step, finalContent, aborted, error },
                noteSettler
              )
            }
          } catch {
            // 吞掉一切:这一支跑在终局事件之前,一次组装 payload 的意外不该把已经答完的一轮改成失败
          }
        },

        takeNotes() {
          const fresh = pending.splice(0, pending.length)
          handed = fresh.length
          return sticky.length === 0 ? fresh : [...sticky, ...fresh]
        }
      }

      return {
        runHooks,
        toolDeps: {
          async beforeToolCall({ call, args, step }) {
            // 串行而不是并发:两份钩子可能都想追加同一段说明,而「谁先谁后」必须可复现;
            // 排完序的名单在同一份快照里是固定的,所以这个顺序与 fs.readdir 无关
            for (const hook of byEvent.get('beforeToolCall') ?? []) {
              if (!covers(hook, call, args)) continue
              const reply = await fire(
                hook,
                {
                  event: 'beforeToolCall',
                  step,
                  call,
                  args,
                  workspaceRelative: workspaceRelative(args, workspace)
                },
                noteSettler
              )
              if (reply.block) {
                // 后面的钩子不再问:这次调用已经不执行了,再问一遍不会带来新信息
                return describeToolBlock(hook.name, reply.reason)
              }
            }
            return undefined
          },

          async afterToolCall({ call, args, step, ok, result, durationMs }) {
            for (const hook of byEvent.get('afterToolCall') ?? []) {
              if (!covers(hook, call, args)) continue
              await fire(
                hook,
                { event: 'afterToolCall', step, call, ok, result, durationMs },
                noteSettler
              )
            }
          }
        }
      }
    }
  }
}
