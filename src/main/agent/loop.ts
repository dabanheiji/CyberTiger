import { streamChatCompletion, type ChatCompletionMessage } from '../chat/llm'
import type { ChatStreamEvent, ToolCallRecord } from '../chat/dto'
import type { Message } from '../chat/sql'
import { toChatCompletionTools, executeTool } from '../tools/registry'
import { buildHistory } from './history'
import { STEP_LIMIT_PROMPT } from './prompt'

/** 一个 run 内最多调用模型的次数(每次可能带多个工具调用) */
export const MAX_STEPS = 10

/** Agent loop 需要的落库操作,由 service 层注入,便于隔离数据库依赖 */
export interface AgentStore {
  listMessages: (conversationId: string) => Message[]
  /** 插入空 assistant 占位行,返回 id */
  addStep: (conversationId: string, runId: string) => string
  /** 一步结束后写回;三者全空时应删除该行 */
  updateStep: (messageId: string, content: string, reasoning: string, calls: ToolCallRecord[]) => void
  removeStep: (messageId: string) => void
  /** 插入 tool 行,返回 id */
  addToolMessage: (
    conversationId: string,
    runId: string,
    toolCallId: string,
    content: string
  ) => string
  /** run 结束后把会话顶到列表最前 */
  touchConversation: (conversationId: string) => void
}

export interface RunAgentParams {
  conversationId: string
  runId: string
  baseUrl: string
  apiKey?: string
  model: string
  signal: AbortSignal
  store: AgentStore
  emit: (event: ChatStreamEvent) => void
}

/**
 * ReAct 式 Agent loop:
 *   推理(模型流式输出 reasoning / content)
 *   → 行动(模型返回 tool_calls,本地执行)
 *   → 观察(工具结果以 tool 消息回填)
 *   → 再推理 …… 直到模型不再发起工具调用或达到上限。
 * 每一步都即时落库并通过 emit 推送给渲染层。
 */
export async function runAgent(params: RunAgentParams): Promise<void> {
  const { conversationId, runId, signal, store, emit } = params
  const base = { conversationId, runId }

  try {
    const history = buildHistory(store.listMessages(conversationId))
    const tools = toChatCompletionTools()

    for (let step = 1; step <= MAX_STEPS + 1; step++) {
      if (signal.aborted) break
      // 超过上限的最后一次调用不给工具,强制模型收尾
      const finalStep = step > MAX_STEPS
      if (finalStep) history.push({ role: 'user', content: STEP_LIMIT_PROMPT })

      const messageId = store.addStep(conversationId, runId)
      emit({ type: 'step_start', ...base, messageId })

      let content = ''
      let reasoning = ''
      let calls: ToolCallRecord[] = []
      try {
        const result = await streamChatCompletion({
          baseUrl: params.baseUrl,
          apiKey: params.apiKey,
          model: params.model,
          messages: history,
          tools: finalStep ? undefined : tools,
          signal,
          onDelta: (delta) => {
            content += delta.content
            reasoning += delta.reasoning
            emit({ type: 'delta', ...base, messageId, content: delta.content, reasoning: delta.reasoning })
          }
        })
        calls = signal.aborted ? [] : result.toolCalls
      } finally {
        // 无论成功、失败还是中止,已收到的内容都要保留
        persistStep(store, messageId, content, reasoning, calls)
      }

      // 收尾步不再执行工具,即便模型仍返回了调用
      if (signal.aborted || calls.length === 0 || finalStep) break

      // 把本步的 assistant 消息追加进历史,再逐个执行工具并追加观察结果
      history.push({
        role: 'assistant',
        content: content || null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments }
        }))
      })

      for (const call of calls) {
        if (signal.aborted) break
        emit({ type: 'tool_call', ...base, messageId, call })
        const exec = await executeTool(call.name, call.arguments)
        const toolMessageId = store.addToolMessage(conversationId, runId, call.id, exec.result)
        emit({
          type: 'tool_result',
          ...base,
          toolMessageId,
          callId: call.id,
          result: exec.result,
          ok: exec.ok
        })
        const toolMessage: ChatCompletionMessage = {
          role: 'tool',
          tool_call_id: call.id,
          content: exec.result
        }
        history.push(toolMessage)
      }
    }

    store.touchConversation(conversationId)
    emit({ type: 'done', ...base, aborted: signal.aborted })
  } catch (error) {
    store.touchConversation(conversationId)
    if (signal.aborted) {
      emit({ type: 'done', ...base, aborted: true })
    } else {
      const msg = error instanceof Error ? error.message : String(error)
      emit({ type: 'error', ...base, msg })
    }
  }
}

/** 有任何内容就写回占位行,否则删除 */
function persistStep(
  store: AgentStore,
  messageId: string,
  content: string,
  reasoning: string,
  calls: ToolCallRecord[]
): void {
  try {
    if (content || reasoning || calls.length > 0) {
      store.updateStep(messageId, content, reasoning, calls)
    } else {
      store.removeStep(messageId)
    }
  } catch (error) {
    // 会话已被删除(级联删掉了占位行)等情况下写库失败不影响主流程
    console.error('[agent] persist step failed:', error)
  }
}
