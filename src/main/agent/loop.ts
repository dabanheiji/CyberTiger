import { streamChatCompletion, type ChatCompletionMessage } from '../chat/llm'
import type { ChatStreamEvent, RunScope, ToolCallRecord } from '../chat/dto'
import type { ToolExecResult, ToolRunner } from '../tools/registry'
import { STEP_LIMIT_PROMPT } from './prompt'

/** 主 agent 一个 run 内最多调用模型的次数(每次可能带多个工具调用) */
export const MAIN_AGENT_MAX_STEPS = 10

/** 锚定消息里引用请求原文的长度上限,避免把整段 skill 正文又抄一遍 */
const ANCHOR_REQUEST_MAX = 200

/**
 * 锚定消息的角色用 user 而不是 system:个别 OpenAI 兼容端点(早期 DeepSeek)不接受
 * system 出现在首位之后,一旦报错会打断所有多步对话;而 user 是项目里已有的循环注入
 * 方式(见 STEP_LIMIT_PROMPT)。若确认目标端点都支持,改成 'system' 语义更准。
 */
const ANCHOR_ROLE = 'user' as const

/**
 * 本轮内工具去重的 key:同名 + 语义相同的参数。
 * 参数是模型生成的 JSON,键序可能不同,所以先排序再比对;解析不了就退回原文
 * (反正执行时也会被参数校验拦下)。
 */
function toolKey(call: ToolCallRecord): string {
  const raw = call.arguments.trim()
  if (!raw) return `${call.name}|{}`
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b)
      )
      return `${call.name}|${JSON.stringify(entries)}`
    }
  } catch {
    // 参数不是合法 JSON,按原文比对
  }
  return `${call.name}|${raw}`
}

/** 取本次 run 要回答的那条请求:历史里最后一条有内容的 user 消息 */
function latestRequest(history: ChatCompletionMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]
    if (message.role !== 'user') continue
    const content = typeof message.content === 'string' ? message.content.trim() : ''
    if (content) return content
  }
  return ''
}

/**
 * 把本次 run 的请求重新贴到消息列表**末尾**,每一步都锚定一次目标。
 *
 * ReAct 循环每转一步,用户的原始问题就被自己的 assistant / tool 消息往下压一层。
 * 小模型跑到第三四步就开始丢目标 —— 实测中用户问"中牟到汝阳的路线",模型在第 4 步
 * 转头去重新查询时间并最终答了时间。放进 system prompt(位置 0)没用,真正起作用的是
 * "近期性",所以必须追加在最后。
 */
function goalAnchor(request: string): ChatCompletionMessage {
  const clipped =
    request.length > ANCHOR_REQUEST_MAX ? `${request.slice(0, ANCHOR_REQUEST_MAX)}…` : request
  return {
    role: ANCHOR_ROLE,
    content:
      `[系统提醒] 本轮只需回应用户最近这一条消息:「${clipped}」。\n` +
      '前面的历史消息只是背景,不要转去回答其中出现过的其他话题。'
  }
}

/** Agent loop 需要的落库操作,由 service 层注入,便于隔离数据库依赖 */
export interface AgentStore {
  /** 插入空 assistant 占位行,返回 id */
  addStep: (scope: RunScope) => string
  /** 一步结束后写回;三者全空时应删除该行 */
  updateStep: (
    messageId: string,
    content: string,
    reasoning: string,
    calls: ToolCallRecord[]
  ) => void
  removeStep: (messageId: string) => void
  /** 插入 tool 行,返回 id */
  addToolMessage: (scope: RunScope, toolCallId: string, content: string) => string
  /** run 结束后把会话顶到列表最前 */
  touchConversation: (conversationId: string) => void
}

export interface RunAgentParams {
  /** 本次 run 的作用域;depth 为 0 即最外层 */
  scope: RunScope
  baseUrl: string
  apiKey?: string
  model: string
  signal: AbortSignal
  /** 已构建好的请求消息(含 system prompt);子 agent 传的是自己的任务 + 专属提示词 */
  history: ChatCompletionMessage[]
  /** 本次 run 可用的工具集合(含查找与执行) */
  runner: ToolRunner
  /** 步数上限;子 agent 通常小于主 agent */
  maxSteps: number
  store: AgentStore
  emit: (event: ChatStreamEvent) => void
}

/** run 的产出;子 agent 的 spawner 依此取回最终回答 */
export interface RunResult {
  /** 终止步的正文(该步为空时回退到最近一个非空正文) */
  finalContent: string
  aborted: boolean
  /** 失败原因;成功时为 undefined */
  error?: string
}

/**
 * ReAct 式 Agent loop:
 *   推理(模型流式输出 reasoning / content)
 *   → 行动(模型返回 tool_calls,本地执行)
 *   → 观察(工具结果以 tool 消息回填)
 *   → 再推理 …… 直到模型不再发起工具调用或达到上限。
 * 每一步都即时落库并通过 emit 推送给渲染层。
 *
 * 只有最外层 run(depth 0)负责收尾:发 done / error 与更新会话排序。
 * 子 agent 的失败通过返回值交给 spawner,由父级那次 task 调用转成 tool_result(ok=false)。
 */
export async function runAgent(params: RunAgentParams): Promise<RunResult> {
  const { scope, signal, store, emit } = params
  const isRoot = scope.depth === 0

  // 复制一份,避免后续 push 污染调用方持有的数组
  const history = [...params.history]
  const tools = params.runner.toChatCompletionTools()
  // 同一 run 内"同名 + 同参数"的工具只真正执行一次。模型有时会为了"更新"重复发起
  // 一模一样的调用(实测:一轮里对 get_current_time 连调两次),这里直接复用上次结果。
  const toolCache = new Map<string, ToolExecResult>()
  // 本次 run 要回答的那条请求(主 agent 是用户的最新消息,子 agent 是任务说明)
  const request = latestRequest(history)
  // 终止步的正文才是答案:停在工具步时 content 为空,继续往后找
  let finalContent = ''

  try {
    for (let step = 1; step <= params.maxSteps + 1; step++) {
      if (signal.aborted) break
      // 超过上限的最后一次调用不给工具,强制模型收尾
      const finalStep = step > params.maxSteps

      // 每步现拼请求消息,不往 history 里累积这些"循环控制"内容
      const messages = [...history]
      if (finalStep) messages.push({ role: 'user', content: STEP_LIMIT_PROMPT })
      // 第 1 步的请求本来就紧跟在 system prompt 后面,无需锚定
      if (step > 1 && request) messages.push(goalAnchor(request))

      const messageId = store.addStep(scope)
      emit({ type: 'step_start', scope, messageId })

      let content = ''
      let reasoning = ''
      let calls: ToolCallRecord[] = []
      try {
        const result = await streamChatCompletion({
          baseUrl: params.baseUrl,
          apiKey: params.apiKey,
          model: params.model,
          messages,
          tools: finalStep ? undefined : tools,
          signal,
          onDelta: (delta) => {
            content += delta.content
            reasoning += delta.reasoning
            emit({
              type: 'delta',
              scope,
              messageId,
              content: delta.content,
              reasoning: delta.reasoning
            })
          }
        })
        calls = signal.aborted ? [] : result.toolCalls
      } finally {
        // 无论成功、失败还是中止,已收到的内容都要保留
        persistStep(store, messageId, content, reasoning, calls)
      }

      if (content) finalContent = content

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
        emit({ type: 'tool_call', scope, messageId, call })
        const key = toolKey(call)
        const cached = toolCache.get(key)
        const exec =
          cached ?? (await params.runner.execute(call.name, call.arguments, { callId: call.id }))
        if (!cached) toolCache.set(key, exec)
        const toolMessageId = store.addToolMessage(scope, call.id, exec.result)
        emit({
          type: 'tool_result',
          scope,
          toolMessageId,
          callId: call.id,
          result: exec.result,
          ok: exec.ok,
          reused: cached !== undefined
        })
        history.push({ role: 'tool', tool_call_id: call.id, content: exec.result })
      }
    }

    if (isRoot) {
      store.touchConversation(scope.conversationId)
      emit({ type: 'done', scope, aborted: signal.aborted })
    }
    return { finalContent, aborted: signal.aborted }
  } catch (error) {
    if (isRoot) store.touchConversation(scope.conversationId)
    if (signal.aborted) {
      if (isRoot) emit({ type: 'done', scope, aborted: true })
      return { finalContent, aborted: true }
    }
    const msg = error instanceof Error ? error.message : String(error)
    if (isRoot) emit({ type: 'error', scope, msg })
    return { finalContent, aborted: false, error: msg }
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
