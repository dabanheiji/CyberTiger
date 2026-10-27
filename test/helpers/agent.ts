import type { AgentStore, ModelStamp } from '../../src/main/agent/loop'
import type { ToolContext, ToolDefinition } from '../../src/main/tools/types'
import { createToolRunner } from '../../src/main/tools/registry'
import type { StreamChatParams, StreamChatResult } from '../../src/main/chat/llm'
import type { ChatStreamEvent, RunScope, ToolCallRecord, TokenUsage } from '../../src/main/chat/dto'

/** 一次 run 的作用域;默认是主 Agent 的顶层 run */
export function rootScope(overrides: Partial<RunScope> = {}): RunScope {
  return {
    conversationId: 'conv-1',
    runId: 'run-1',
    agent: '',
    parentCallId: '',
    depth: 0,
    ...overrides
  }
}

/** 子 Agent 的 run 作用域,靠 parentCallId 挂到某次 task 调用下 */
export function subScope(parentCallId: string, agent = 'researcher'): RunScope {
  return rootScope({ agent, parentCallId, depth: 1 })
}

export interface StoredStep {
  id: string
  scope: RunScope
  /** 这一步落库时盖上的模型归属;报表按它归集用量 */
  stamp: ModelStamp
  content: string
  reasoning: string
  calls: ToolCallRecord[]
  /** loop 写回的本步用量;落库实现靠它拼 SQL */
  usage?: TokenUsage
}

export interface FakeStore extends AgentStore {
  steps: Map<string, StoredStep>
  toolRows: Array<{ id: string; toolCallId: string; content: string; scope: RunScope }>
  removedIds: string[]
  touched: string[]
}

/** 记录落库操作的 AgentStore 实现,loop 的持久化分支全靠它断言 */
export function makeStore(): FakeStore {
  const steps = new Map<string, StoredStep>()
  const toolRows: FakeStore['toolRows'] = []
  const removedIds: string[] = []
  const touched: string[] = []
  let seq = 0

  return {
    steps,
    toolRows,
    removedIds,
    touched,
    addStep: (scope: RunScope, stamp: ModelStamp) => {
      const id = `step-${++seq}`
      steps.set(id, { id, scope, stamp, content: '', reasoning: '', calls: [] })
      return id
    },
    updateStep: (messageId, content, reasoning, calls, usage) => {
      const step = steps.get(messageId)
      if (step) Object.assign(step, { content, reasoning, calls, usage })
    },
    removeStep: (messageId) => {
      steps.delete(messageId)
      removedIds.push(messageId)
    },
    addToolMessage: (scope: RunScope, toolCallId, content) => {
      const id = `tool-${++seq}`
      toolRows.push({ id, toolCallId, content, scope })
      return id
    },
    touchConversation: (conversationId) => {
      touched.push(conversationId)
    }
  }
}

/** 测试用工具:run 是执行体,executed 记录每次真实执行的入参原文 */
export interface TestTool {
  run: (args: Record<string, unknown>, context: ToolContext) => string
  /** 该工具的旧结果是否随时间失效(见 agent/history.ts) */
  volatile?: boolean
  executed: Array<{ args: string; callId: string }>
}

function toDefinition(name: string, tool: TestTool): ToolDefinition {
  return {
    name,
    description: `测试工具 ${name}`,
    parameters: { type: 'object', properties: {} },
    volatile: tool.volatile,
    execute: (args, context) => {
      tool.executed.push({ args: JSON.stringify(args), callId: context.callId })
      return tool.run(args, context)
    }
  }
}

/** 造一个会记录调用次数的工具 */
export function makeTool(result: string | ((args: Record<string, unknown>) => string)): TestTool {
  return {
    executed: [],
    run: (args) => (typeof result === 'function' ? result(args) : result)
  }
}

export function makeVolatile(result: string): TestTool {
  return { ...makeTool(result), volatile: true }
}

/**
 * 用真实的 createToolRunner 组装工具集:参数校验、未知工具拒绝这些行为都要一起被验证,
 * 所以不自己造 ToolRunner。
 */
export function makeRunner(tools: Record<string, TestTool>): ReturnType<typeof createToolRunner> {
  return createToolRunner(Object.entries(tools).map(([name, t]) => toDefinition(name, t)))
}

/** 脚本化的一次模型输出 */
export interface ModelStep {
  content?: string
  reasoning?: string
  toolCalls?: ToolCallRecord[]
  /** 端点上报的 usage;不给就模拟"兼容端点不报用量"的情形 */
  usage?: { prompt: number; completion: number }
}

export interface FakeModel {
  stream: (params: StreamChatParams) => Promise<StreamChatResult>
  /** 每次调用收到的请求快照;断言锚定位置与 tools 是否下发都靠它 */
  requests: StreamChatParams[]
}

/** 按脚本依次产出各步输出;脚本用完即表示模型不再调用工具 */
export function makeModel(script: ModelStep[]): FakeModel {
  const requests: StreamChatParams[] = []
  return {
    requests,
    stream: async (params: StreamChatParams) => {
      // messages 会被 loop 每步现拼,存副本才不会看到后续 push 造成的变化
      requests.push({ ...params, messages: [...params.messages] })
      const step = script[requests.length - 1]
      if (!step) return { toolCalls: [] }
      if (step.reasoning) params.onDelta({ content: '', reasoning: step.reasoning })
      if (step.content) {
        const mid = Math.ceil(step.content.length / 2)
        params.onDelta({ content: step.content.slice(0, mid), reasoning: '' })
        params.onDelta({ content: step.content.slice(mid), reasoning: '' })
      }
      return { toolCalls: step.toolCalls ?? [], ...(step.usage ? { usage: step.usage } : {}) }
    }
  }
}

let callSeq = 0

/** 造一次工具调用记录;不传 id 时自动生成 */
export function makeCall(name: string, args: string, id?: string): ToolCallRecord {
  return { id: id ?? `call-${++callSeq}`, name, arguments: args }
}

export interface CollectedRun {
  events: ChatStreamEvent[]
  /** 按类型筛事件 */
  of<K extends ChatStreamEvent['type']>(type: K): Extract<ChatStreamEvent, { type: K }>[]
}

export function makeEmit(): {
  emit: (event: ChatStreamEvent) => void
  collected: CollectedRun
} {
  const events: ChatStreamEvent[] = []
  const emit = (event: ChatStreamEvent): void => {
    events.push(event)
  }
  return {
    emit,
    collected: {
      events,
      of: <K extends ChatStreamEvent['type']>(type: K) =>
        events.filter((e) => e.type === type) as Extract<ChatStreamEvent, { type: K }>[]
    }
  }
}
