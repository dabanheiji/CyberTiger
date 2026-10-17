import { v4 as uuidv4 } from 'uuid'
import type {
  ApprovalRequest,
  ApprovalSettlement,
  ChatStreamEvent,
  PendingApprovalDto,
  RunScope
} from './dto'
import type { ApprovalGate } from './approvals'
import type { PermissionLists } from '../tools/permission'
import type { PermissionMode } from '../store/types'
import { needsApproval } from '../tools/permission'
import type { ToolContext, ToolExecResult, ToolRunner } from '../tools/registry'

/**
 * 把审批闸门套在一个已有的 ToolRunner 上。
 *
 * 套在 runner 而不是改 `agent/loop.ts`:loop 在 `emit({type:'tool_call'})` 之后才
 * `await runner.execute`,所以 `tool_approval` 天然排在「这次调用已开始」之后,
 * 界面顺序不用重排,也一定晚于 IPC 应答(不像第一步的 `step_start` 有竞态),不需要 `ensureStep`。
 * 更关键的是主 Agent 与子 Agent **共用同一个装饰器**:`task` 派出的子 run 自己拍 runner 快照,
 * 只给主 Agent 加闸门的话,模型走子 Agent 就绕开了整道审批 —— 那是结构性的洞。
 *
 * `definitions` 原样透传:发给模型的工具列表与能执行的范围必须严格一致(registry 既有纪律)。
 */
export interface ApprovalDeps {
  /**
   * 每次调用现读档位,而不是 run 开始时拍一次快照:
   * 用户在 run 跑动中点「询问审批」要能立刻刹住正在跑的那一轮(收紧立即),
   * 而放宽只能等下一轮 —— 这一条由 service 用「取更严的那档」保证,这里只管读。
   */
  modeOf: () => PermissionMode
  lists: PermissionLists
  /** 本次 run 的工作空间,空串即未选择 */
  workspace: string
  scope: RunScope
  signal: AbortSignal
  /** 全局审批通道:controller 收决定时按 id 找得到这里登记的等待 */
  gate: ApprovalGate
  /**
   * 「本轮同类都允许」已经放行的类。
   * 父子 run 共享同一份:主 Agent 批过的类,子 Agent 里再问一次没有新信息。
   */
  runAllow: Set<string>
  /** 该工具是否由 MCP server 提供(外部代码,整档纳入审批面) */
  mcpToolNames: ReadonlySet<string>
  emit: (event: ChatStreamEvent) => void
  /** 窗口没在前台时叫用户回来:审批会让 run 停在人身上,而人可能根本没在看这个窗口 */
  notify?: (request: ApprovalRequest) => void
}

/**
 * 拒绝 / 中止 / 超时的结论,全部写成陈述句。
 *
 * 不写「请换个方式」「请再向用户确认」:模型会把祈使当成本轮待办去执行,
 * 这个项目在工具结果文案上已经踩过三次(见 AGENTS.md 的错误处理一条)。
 * 三种了结各说一件事 —— 谁没批、有没有补原因、操作确实没进行。
 */
/** 三种「没有批准」的了结:allow 两支不会走到这段文案 */
type Refusal = Exclude<ApprovalSettlement, { kind: 'allow' } | { kind: 'allow_run' }>

export function describeSettlement(settlement: Refusal): string {
  switch (settlement.kind) {
    case 'deny':
      return settlement.reason
        ? `用户拒绝了这次操作,操作没有进行。\n用户给出的原因:${settlement.reason}`
        : '用户拒绝了这次操作,操作没有进行。'
    case 'aborted':
      return '[本轮已中止,没有做出审批,操作没有进行]'
    case 'timeout':
      return '[等待审批超时,没有人做出决定,操作没有进行]'
  }
}

/** 参数解析不了的调用不进审批:让内层 runner 给出那句「参数不是合法的 JSON」更准 */
function parseArgs(argumentsJson: string): Record<string, unknown> | undefined {
  const trimmed = argumentsJson.trim()
  if (!trimmed) return {}
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // 交给内层 runner 报错
  }
  return undefined
}

export function withApproval(runner: ToolRunner, deps: ApprovalDeps): ToolRunner {
  const { gate, scope, signal, emit, runAllow, mcpToolNames } = deps

  const execute = async (
    name: string,
    argumentsJson: string,
    context: ToolContext
  ): Promise<ToolExecResult> => {
    const args = parseArgs(argumentsJson)
    if (!args) return runner.execute(name, argumentsJson, context)

    const requirement = needsApproval({
      mode: deps.modeOf(),
      toolName: name,
      args,
      workspace: deps.workspace,
      isMcpTool: mcpToolNames.has(name),
      lists: deps.lists,
      agent: scope.agent
    })
    if (!requirement) return runner.execute(name, argumentsJson, context)
    // 同一轮里用户已经批过这一类:直接放行,不再打断
    if (runAllow.has(requirement.runAllowKey)) return runner.execute(name, argumentsJson, context)

    const request: ApprovalRequest = {
      approvalId: uuidv4(),
      // callId 由工具上下文给出:渲染层靠它在同一次调用的 tool_result 到手时收起卡片
      callId: context.callId,
      tool: name,
      ...requirement,
      agent: scope.agent
    }
    // 带 conversationId 登记:渲染层重载后按会话把还挂着的卡片拉回来
    const pending: PendingApprovalDto = { ...request, conversationId: scope.conversationId }
    emit({ type: 'tool_approval', scope, request })
    deps.notify?.(request)

    const settlement = await gate.open(pending, signal)
    if (settlement.kind === 'allow') return runner.execute(name, argumentsJson, context)
    if (settlement.kind === 'allow_run') {
      runAllow.add(request.runAllowKey)
      return runner.execute(name, argumentsJson, context)
    }
    return { ok: false, result: describeSettlement(settlement) }
  }

  return {
    definitions: runner.definitions,
    toChatCompletionTools: () => runner.toChatCompletionTools(),
    execute
  }
}
