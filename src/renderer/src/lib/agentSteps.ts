import type { ToolCallRecord } from '../../../main/chat/dto'

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
