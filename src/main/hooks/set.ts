import path from 'node:path'
import type { RunScope, ToolCallRecord } from '../chat/dto'
import type { ToolContext } from '../tools/registry'
import { anchor } from '../tools/paths'
import type { SandboxSettings } from '../store/types'
import { boundaryOf } from './boundary'
import type { HookPayload, HookTrigger } from './contract'
import { MAX_NOTES_PER_STEP, buildPayload, describeToolBlock } from './contract'
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
  /** 两个工具事件的那一半,交给 `chat/hook.ts` 的装饰器 */
  toolDeps: ToolHookDeps
  /**
   * 本步攒下的说明,由 loop 每步现取。
   *
   * 顺序是「先整个 run 常驻的(`beforeAgent` 那条),后本步新增的」,再拼在本轮目标锚定**之前**
   * —— 锚定靠「近期性」起作用,排到它后面才不破坏那条既有不变量。
   */
  takeNotes(): string[]
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
      // 本步待贴进请求的说明。上限在这里挡,不在界面或 loop 挡:一个碎嘴的钩子不该把
      // planContext 推进缩写档,开始裁真正的工具结果
      const pending: string[] = []

      const pushNote = (note: string): boolean => {
        if (pending.length >= MAX_NOTES_PER_STEP) return false
        pending.push(note)
        return true
      }

      /** 一份回执落地:说明进缓冲区,否决由调用方读 `reply.block` 自己处理 */
      const apply = (hook: HookMeta, reply: HookReply): HookDisposition => {
        if (reply.block) return { decision: 'blocked' }
        if (reply.note === '') return { decision: 'noop' }
        if (pushNote(reply.note)) return { decision: 'adopted' }
        return {
          decision: 'noop',
          log: `本步的说明已达 ${String(MAX_NOTES_PER_STEP)} 条上限,${hook.name} 这一条被丢掉`
        }
      }

      const fire = async (hook: HookMeta, trigger: HookTrigger): Promise<HookReply> => {
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
          apply: (reply) => apply(hook, reply)
        })
      }

      return {
        toolDeps: {
          async beforeToolCall({ call, args, step }) {
            // 串行而不是并发:两份钩子可能都想追加同一段说明,而「谁先谁后」必须可复现;
            // 排完序的名单在同一份快照里是固定的,所以这个顺序与 fs.readdir 无关
            for (const hook of byEvent.get('beforeToolCall') ?? []) {
              if (!covers(hook, call, args)) continue
              const reply = await fire(hook, {
                event: 'beforeToolCall',
                step,
                call,
                args,
                workspaceRelative: workspaceRelative(args, workspace)
              })
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
              await fire(hook, {
                event: 'afterToolCall',
                step,
                call,
                ok,
                result,
                durationMs
              })
            }
          }
        },
        takeNotes() {
          return pending.splice(0, pending.length)
        }
      }
    }
  }
}
