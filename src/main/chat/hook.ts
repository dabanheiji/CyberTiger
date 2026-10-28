import type { ToolCallRecord } from './dto'
import type { ToolHookDeps } from '../hooks/set'
import type { ToolContext, ToolExecResult, ToolRunner } from '../tools/registry'
import { parseToolArgs } from '../tools/registry'

/**
 * 把两个工具事件钩子套在一个已有的 ToolRunner 上。
 *
 * 与审批闸门同一个装饰器形状(`chat/approval.ts`),因而 `loop.ts` 一行没改:
 * 事件照旧落在同一次调用的 `tool_call` 与 `tool_result` 之间,而钩子自己不进
 * `ChatStreamEvent` 那套判别联合(它的可观测性归 `userData/logs/hooks.jsonl` 与设置页)。
 *
 * **它套在闸门外面**(`withHooks(withGate(...))`),顺序是政策层先于人:
 * ① 卡片不该承诺一件注定失败的事 —— 钩子正要拦下这次调用时,不该先让用户批一遍;
 * ② 一次钩子是 50–500 ms,一次审批是等人(上限 `APPROVAL_TIMEOUT_MS` = 3 分钟),
 *    把人叫回来之后再告诉他「其实这条不用批,钩子拦住了」是最差的体验;
 * ③ 用户装的钩子属于本机策略,策略该在注意力之前生效。
 * 代价要说清:被钩子拦下的调用**一次审批都不发**,而那句否决与「用户拒绝了」是两回事
 * (`describeToolBlock` 点名钩子),模型据此不会换成写法再问人。
 *
 * `definitions` 原样透传:发给模型的工具列表与能执行的范围必须严格一致(registry 既有纪律)。
 */
export function withHooks(runner: ToolRunner, deps: ToolHookDeps): ToolRunner {
  const execute = async (
    name: string,
    argumentsJson: string,
    context: ToolContext
  ): Promise<ToolExecResult> => {
    const call: ToolCallRecord = { id: context.callId, name, arguments: argumentsJson }
    // 步号只有 loop 知道,而 payload 与日志都要它;没给就是「不知道在第几步」,不是第 1 步
    const step = context.step ?? 0
    // 与闸门共用同一份解析:参数不是合法 JSON 时两边都读成 null,
    // 而**这一次调用照样要被看见**(钩子可能在审计谁在发坏参数),所以不提前 return
    const args = parseToolArgs(argumentsJson) ?? null
    const veto = await deps.beforeToolCall({ call, args, step })
    if (veto) return { ok: false, result: veto }

    const startedAt = Date.now()
    const exec = await runner.execute(name, argumentsJson, context)
    // 事后事件没有否决权,所以它的毛病不该影响那次调用的结论;但它的说明要进下一步,
    // 于是这里照常 await —— 抛不出去(set.ts 那一侧的 fire 只走 runHook,它永不 reject)
    await deps.afterToolCall({
      call,
      args,
      step,
      ok: exec.ok,
      result: exec.result,
      durationMs: Date.now() - startedAt
    })
    return exec
  }

  return {
    definitions: runner.definitions,
    toChatCompletionTools: () => runner.toChatCompletionTools(),
    execute
  }
}
