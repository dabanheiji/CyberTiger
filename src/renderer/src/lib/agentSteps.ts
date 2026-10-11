import type { ContextMeter, TokenUsage, ToolCallRecord } from '../../../main/chat/dto'

/** 流式中的一个工具调用及其执行状态 */
export interface StreamingToolCall extends ToolCallRecord {
  status: 'running' | 'success' | 'error'
  result?: string
  /**
   * 命中了同一 run 内的去重缓存,本次没有真正执行工具。
   * 只有实时流里带得回来;历史回放无法还原,会退回普通的"已完成"。
   */
  reused?: boolean
  /** 子 Agent 的执行步骤;普通工具调用没有 */
  agentSteps?: AgentStep[]
  /** 子 Agent 角色名;通用子 Agent 为空 */
  agentName?: string
}

/** Agent 的一步:一次模型调用产生的推理、正文与行动 */
export interface AgentStep {
  messageId: string
  content: string
  reasoning: string
  toolCalls: StreamingToolCall[]
  /** 本步 token 用量;历史行没写过用量时没有 */
  usage?: TokenUsage
  /** 本步请求为塞进上下文预算做了什么 */
  context?: ContextMeter
}

/**
 * 子 Agent 的过程嵌在父级工具调用的 agentSteps 里,于是「按 id 定位」和
 * 「不可变替换」都必须在整棵树上递归。下面几个纯函数是 useAgentStream 与
 * 聊天页共用的树操作,集中在这里避免两边各写一份。
 */

/** 新建一个空步骤 */
export function emptyStep(messageId: string): AgentStep {
  return { messageId, content: '', reasoning: '', toolCalls: [] }
}

/** 在任意深度查找某个工具调用 */
export function findCall(steps: AgentStep[], callId: string): StreamingToolCall | undefined {
  for (const step of steps) {
    for (const call of step.toolCalls) {
      if (call.id === callId) return call
      if (call.agentSteps) {
        const hit = findCall(call.agentSteps, callId)
        if (hit) return hit
      }
    }
  }
  return undefined
}

/** 不可变地替换任意深度上的某个步骤 */
export function mapStep(
  steps: AgentStep[],
  messageId: string,
  fn: (step: AgentStep) => AgentStep
): AgentStep[] {
  return steps.map((step) => {
    if (step.messageId === messageId) return fn(step)
    if (!step.toolCalls.some((c) => c.agentSteps)) return step
    return {
      ...step,
      toolCalls: step.toolCalls.map((call) =>
        call.agentSteps ? { ...call, agentSteps: mapStep(call.agentSteps, messageId, fn) } : call
      )
    }
  })
}

/** 不可变地替换任意深度上的某个工具调用 */
export function mapCall(
  steps: AgentStep[],
  callId: string,
  fn: (call: StreamingToolCall) => StreamingToolCall
): AgentStep[] {
  return steps.map((step) => ({
    ...step,
    toolCalls: step.toolCalls.map((call) => {
      if (call.id === callId) return fn(call)
      if (!call.agentSteps) return call
      return { ...call, agentSteps: mapCall(call.agentSteps, callId, fn) }
    })
  }))
}

/** tool 行:从最近的一步往前找对应的调用并填入结果 */
export function attachToolResult(steps: AgentStep[], toolCallId: string, result: string): void {
  for (let i = steps.length - 1; i >= 0; i--) {
    const idx = steps[i].toolCalls.findIndex((c) => c.id === toolCallId)
    if (idx === -1) continue
    steps[i].toolCalls[idx] = { ...steps[i].toolCalls[idx], status: 'success', result }
    return
  }
}

/** 落库数据里仍是 running 的调用说明当时被中止,标为失败(含子 Agent 里的调用) */
export function finalizeStep(step: AgentStep): AgentStep {
  return {
    ...step,
    toolCalls: step.toolCalls.map((call) => {
      const next = { ...call }
      if (next.status === 'running') {
        next.status = 'error'
        next.result = '已中止'
      }
      if (next.agentSteps) next.agentSteps = next.agentSteps.map(finalizeStep)
      return next
    })
  }
}

/** 库消息行的三个用量整数列 → 用量对象;旧数据没写过用量,返回 undefined 就不显示 */
export function toStepUsage(row: {
  prompt_tokens: number
  completion_tokens: number
  tokens_estimated: number
}): TokenUsage | undefined {
  if (row.prompt_tokens === 0 && row.completion_tokens === 0) return undefined
  return {
    prompt: row.prompt_tokens,
    completion: row.completion_tokens,
    estimated: row.tokens_estimated === 1
  }
}

/** 一次回复(含子 Agent)的用量合计 */
export interface UsageSummary {
  /** 最近一次请求的输入占用 —— 各步的输入是包含关系,相加会把同一批历史数好几遍 */
  prompt: number
  /** 各步输出之和,才是这次回复真正生成的量 */
  completion: number
  /** 只要有一步是估算值就整体标估算:混合显示更说不清 */
  estimated: boolean
  /** 为塞进预算丢弃的历史轮数(取各步最大值,裁的是同一份上下文) */
  droppedTurns: number
  /** 最近一轮内部被弃掉的消息条数 */
  droppedMessages: number
  /** 被就地缩写的消息条数 */
  shrunkMessages: number
}

/**
 * 把一个回复的各步(递归含子 Agent)汇总成一行显示。
 * 子 Agent 的用量必须并进来:它确实花了 token,少算等于报假账。
 */
export function summarizeUsage(steps: AgentStep[]): UsageSummary | null {
  const summary: UsageSummary = {
    prompt: 0,
    completion: 0,
    estimated: false,
    droppedTurns: 0,
    droppedMessages: 0,
    shrunkMessages: 0
  }
  let found = false

  const visit = (list: AgentStep[]): void => {
    for (const step of list) {
      if (step.usage) {
        found = true
        summary.prompt = Math.max(summary.prompt, step.usage.prompt)
        summary.completion += step.usage.completion
        summary.estimated = summary.estimated || step.usage.estimated
      }
      if (step.context) {
        summary.droppedTurns = Math.max(summary.droppedTurns, step.context.droppedTurns)
        summary.droppedMessages = Math.max(summary.droppedMessages, step.context.droppedMessages)
        summary.shrunkMessages = Math.max(summary.shrunkMessages, step.context.shrunkMessages)
      }
      for (const call of step.toolCalls) {
        if (call.agentSteps) visit(call.agentSteps)
      }
    }
  }
  visit(steps)

  return found ? summary : null
}
