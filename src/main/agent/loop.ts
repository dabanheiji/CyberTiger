import {
  streamChatCompletion,
  type ChatCompletionMessage,
  type ReportedUsage,
  type StreamChatParams,
  type StreamChatResult
} from '../chat/llm'
import type {
  ChatStreamEvent,
  RunScope,
  SummaryMetrics,
  ToolCallRecord,
  TokenUsage
} from '../chat/dto'
import type { ToolExecResult, ToolRunner } from '../tools/registry'
import { estimateRequestTokens, estimateTextTokens } from '../tokens/estimate'
import {
  isSummaryBlock,
  summaryBlock,
  taskStateNote,
  type CompactSizing,
  type CompactUnit
} from './compact'
import { splitIdentifiedUnits, tokensOf, type IdentifiedMessage, type UnitOf } from './turns'
import { budgetFor, planContext, type ContextBudget } from './context'
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
 * 把带 id 的单元换成压缩模块要的单元形状。
 * 摘要只需要边界、token 数和水位落点;每条消息的 id 留在 loop 手里,
 * 压完重建上下文时还要靠它对齐。
 */
function asCompactUnits(units: UnitOf<IdentifiedMessage>[]): CompactUnit[] {
  return units.map((unit) => ({
    messages: unit.items.map((item) => item.message),
    tokens: unit.tokens,
    lastId: unit.items[unit.items.length - 1].id
  }))
}

/**
 * 把本次 run 的请求重新贴到消息列表**末尾**,每一步都锚定一次目标。
 *
 * ReAct 循环每转一步,用户的原始问题就被自己的 assistant / tool 消息往下压一层。
 * 小模型跑到第三四步就开始丢目标 —— 实测中用户问"中牟到汝阳的路线",模型在第 4 步
 * 转头去重新查询时间并最终答了时间。放进 system prompt(位置 0)没用,真正起作用的是
 * "近期性",所以必须追加在最后。
 *
 * 最后一句不能省:锚定形似一条新提问,实测中模型读到重复的请求后把"要答时间"当成
 * 还没做的事,连着三步换着时区名重调 get_current_time。它只说"已拿到的不必再取",
 * 不写"请重新调用"这类祈使 —— 那正是把模型推回去重复调用的写法。
 */
function goalAnchor(request: string): ChatCompletionMessage {
  const clipped =
    request.length > ANCHOR_REQUEST_MAX ? `${request.slice(0, ANCHOR_REQUEST_MAX)}…` : request
  return {
    role: ANCHOR_ROLE,
    content:
      `[系统提醒] 本轮只需回应用户最近这一条消息:「${clipped}」。\n` +
      '前面的历史消息只是背景,不要转去回答其中出现过的其他话题。\n' +
      '上面已经执行过的工具及其结果就是本轮拿到的信息,已拿到的不需要重新获取。'
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
    calls: ToolCallRecord[],
    /** 本步的 token 用量,用于界面显示与后续预算校准 */
    usage: TokenUsage
  ) => void
  removeStep: (messageId: string) => void
  /** 插入 tool 行,返回 id */
  addToolMessage: (scope: RunScope, toolCallId: string, content: string) => string
  /** run 结束后把会话顶到列表最前 */
  touchConversation: (conversationId: string) => void
}

/** 一次 run 中途压缩所需的注入点 */
export type RunCompactor = (request: RunCompactRequest) => Promise<RunCompactResult>

/**
 * loop 交给 service 的压缩请求。
 *
 * 单元、规模与「正在做什么」都由 loop 算 —— 它最清楚下一步要发什么,也才拿得到执行结论;
 * 落库与推进水位由 service 做 —— 循环模块不碰 DB,和 AgentStore 同一个理由。
 */
export interface RunCompactRequest {
  scope: RunScope
  /** 触发压缩的那一步(从 1 起),写进便签当作进度 */
  step: number
  /** 本次 run 要回答的请求 */
  request: string
  /** 当前上下文的单元切分(带库内 id),边界只能落在这些单元上 */
  units: CompactUnit[]
  /** 规模:固定开销(system + 工具 + 锚定)、当前摘要占用、模型配置的窗口 */
  sizing: CompactSizing
  /** 当前生效的摘要;新摘要在它基础上合并 */
  summary: string
  /** 执行状态便签:任务能跨压缩续跑全靠它 */
  note: string
}

/** 压缩的结论;`compacted === false` 时 loop 什么都不改 */
export interface RunCompactResult {
  compacted: boolean
  /** 新摘要:替换旧的那份,而不是叠加 */
  summary?: string
  /** 被摘要覆盖掉的单元数(从最旧数起):loop 据此重建自己的上下文 */
  coveredUnits?: number
  usage?: TokenUsage
  metrics?: SummaryMetrics
  /** 摘要调用失败或被中止时的中文提示 */
  msg?: string
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
  /**
   * 上下文预算;缺省按 32k 兜底窗口算。
   * 每步请求都照它裁剪 —— 长工具链的 run 会把自己的工具结果一路堆到几万 token,
   * 只裁历史不裁 run 内等于没裁。
   */
  budget?: ContextBudget
  /**
   * 模型调用实现,默认走真实的流式接口。
   * 与 AgentStore 同样的注入风格,让 ReAct 循环的每条分支能在无网络条件下被验证。
   */
  stream?: (params: StreamChatParams) => Promise<StreamChatResult>
  /**
   * run 中途的上下文压缩。只有主 Agent 传:子 Agent 上下文本来就是自己那份任务,
   * 压掉的过程它自己还要用,再压一次只会把结论压没(取舍见 AGENTS.md)。
   *
   * `historyIds` 必须与 history 里「水位之后的那些行」一一对应(不含 system 与摘要块):
   * 水位要落在具体一条已落库的消息上,没有 id 就推不动。两者打包成一个对象,
   * 就是为了防止只传一半 —— 少了 id 的压缩会写出一个对不上行的水位。
   */
  compaction?: { summary: string; historyIds: string[]; run: RunCompactor }
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
  const stream = params.stream ?? streamChatCompletion
  const isRoot = scope.depth === 0
  const budget = params.budget ?? budgetFor()

  // 复制一份,避免后续 push 污染调用方持有的数组
  const source = [...params.history]
  // 首位的 system 固定保留,其余消息才进裁剪
  const system = source[0]?.role === 'system' ? source[0] : undefined
  const rest = system ? source.slice(1) : source
  // 紧跟 system 的摘要块与它同属固定头部:它替代的正是被压掉的那段历史,
  // 再参与逐步裁剪就会把「摘要」也裁掉,模型于是彻底失去前情
  let head: ChatCompletionMessage[] = []
  while (isSummaryBlock(rest[head.length])) head.push(rest[head.length])
  // 上下文带着库内 id:压缩的水位必须落在具体某条已落库的消息上,没有 id 就推不动水位。
  // 不压缩的 run(子 Agent)填空串,那些位置永远不会被当成水位落点。
  const ids = params.compaction?.historyIds ?? []
  let context: IdentifiedMessage[] = rest
    .slice(head.length)
    .map((message, i) => ({ id: ids[i] ?? '', message }))
  const messages = (): ChatCompletionMessage[] => context.map((item) => item.message)
  const tools = params.runner.toChatCompletionTools()
  // 同一 run 内"同名 + 同参数"的工具只真正执行一次。模型有时会为了"更新"重复发起
  // 一模一样的调用(实测:一轮里对 get_current_time 连调两次),这里直接复用上次结果。
  const toolCache = new Map<string, ToolExecResult>()
  // 本次 run 要回答的那条请求(主 agent 是用户的最新消息,子 agent 是任务说明)
  const request = latestRequest(messages())
  // 当前生效的摘要:中途压缩会换掉它,下一次压缩要在新的那份基础上继续合并
  let summary = params.compaction?.summary ?? ''
  // 终止步的正文才是答案:停在工具步时 content 为空,继续往后找
  let finalContent = ''

  try {
    for (let step = 1; step <= params.maxSteps + 1; step++) {
      if (signal.aborted) break
      // 超过上限的最后一次调用不给工具,强制模型收尾
      const finalStep = step > params.maxSteps
      const stepTools = finalStep ? [] : tools

      // 每步现拼请求消息,不往 context 里累积这些"循环控制"内容
      const pinned: ChatCompletionMessage[] = []
      if (finalStep) pinned.push({ role: 'user', content: STEP_LIMIT_PROMPT })
      // 第 1 步的请求本来就紧跟在 system prompt 后面,无需锚定
      if (step > 1 && request) pinned.push(goalAnchor(request))
      const plan = planContext({
        system,
        head,
        history: messages(),
        pinned,
        tools: stepTools,
        budget
      })
      const estimatedPrompt = estimateRequestTokens(plan.messages, stepTools)

      const messageId = store.addStep(scope)
      emit({ type: 'step_start', scope, messageId })

      let content = ''
      let reasoning = ''
      let calls: ToolCallRecord[] = []
      let reported: ReportedUsage | undefined
      try {
        const result = await stream({
          baseUrl: params.baseUrl,
          apiKey: params.apiKey,
          model: params.model,
          messages: plan.messages,
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
        reported = result.usage
      } finally {
        // 无论成功、失败还是中止,已收到的内容都要保留
        const usage = toUsage(
          reported,
          estimatedPrompt,
          estimateTextTokens(content) + estimateTextTokens(reasoning)
        )
        persistStep(store, messageId, content, reasoning, calls, usage)
        // 空步(整行被删掉)没有用量可报
        if (content || reasoning || calls.length > 0 || reported) {
          emit({ type: 'usage', scope, messageId, usage, context: plan.meter })
        }
      }

      if (content) finalContent = content

      // 收尾步(工具已被收走)与中止都不再执行调用,但这些调用已随 assistant 行落库,
      // 必须各有一条 tool 行收尾,否则下一轮回放就是孤儿 tool_calls
      if (signal.aborted || calls.length === 0 || finalStep) {
        settleUnexecuted(store, scope, emit, calls, new Set())
        break
      }

      // 把本步的 assistant 消息追加进上下文,再逐个执行工具并追加观察结果
      context.push({
        id: messageId,
        message: {
          role: 'assistant',
          content: content || null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function' as const,
            function: { name: c.name, arguments: c.arguments }
          }))
        }
      })

      const executed = new Set<string>()
      // 本轮已执行的工具与结论:中途压缩时写进便签,续跑才知道什么不必再做
      const conclusions: { name: string; arguments: string; ok: boolean; result: string }[] = []
      for (const call of calls) {
        if (signal.aborted) break
        emit({ type: 'tool_call', scope, messageId, call })
        const key = toolKey(call)
        const cached = toolCache.get(key)
        const exec =
          cached ??
          (await params.runner.execute(call.name, call.arguments, { callId: call.id, signal }))
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
        context.push({
          id: toolMessageId,
          message: { role: 'tool', tool_call_id: call.id, content: exec.result }
        })
        conclusions.push({
          name: call.name,
          arguments: call.arguments,
          ok: exec.ok,
          result: exec.result
        })
        executed.add(call.id)
      }
      // 循环中途被停止:剩下的调用同样已经落库,一样要收尾
      settleUnexecuted(store, scope, emit, calls, executed)

      // 越过触发线就在这次工具之后压一次:下一步的请求就只带摘要 + 最近的原文。
      // 收尾步不做 —— 下一步不给工具,本来就小,压了反而把要用的结论摘没。
      if (params.compaction && !signal.aborted && step < params.maxSteps) {
        const units = splitIdentifiedUnits(context)
        const result = await params.compaction.run({
          scope,
          step,
          request,
          units: asCompactUnits(units),
          // 固定开销只算 system + 工具 + 下一步要贴的锚定;摘要单独作为 summaryTokens
          sizing: {
            fixedTokens: estimateRequestTokens(
              [...(system ? [system] : []), ...(request ? [goalAnchor(request)] : [])],
              tools
            ),
            summaryTokens: tokensOf(head),
            window: budget.window
          },
          summary,
          note: taskStateNote({
            request,
            step,
            maxSteps: params.maxSteps,
            executed: conclusions,
            lastAssistant: content
          })
        })
        if (result.usage) {
          emit({
            type: 'compact',
            scope,
            messageId,
            ok: result.compacted,
            usage: result.usage,
            ...(result.metrics ? { metrics: result.metrics } : {}),
            ...(result.msg ? { msg: result.msg } : {})
          })
        }
        if (result.compacted && result.summary && typeof result.coveredUnits === 'number') {
          // 上下文换成「新摘要 + 没被覆盖的后缀」:此后每一步都从这个新前缀继续长
          summary = result.summary
          head = [summaryBlock(summary)]
          context = units.slice(result.coveredUnits).flatMap((unit) => unit.items)
        }
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

/** 本轮没来得及执行的工具调用,它的 tool 行写这个占位结论 */
const UNEXECUTED_RESULT = '[本轮未执行,无结果]'

/**
 * 给「已落库的 assistant 行里没能执行的调用」补上 tool 行。
 *
 * assistant 行只要带着 tool_calls 进了库,每个调用 id 就必须有一条对应的 tool 行,
 * 否则下一轮回放出现「有调用无响应」的孤儿行 —— 严格的 OpenAI 兼容端点直接 400,
 * 而这状态会被摘要压缩永久固化下去。两条分支会走到这里:
 *   - 收尾步:工具已被收走,模型却仍然返回了调用(见 `finalStep`);
 *   - 中途停止:3 个调用只跑了 1 个,用户按了停止。
 */
function settleUnexecuted(
  store: AgentStore,
  scope: RunScope,
  emit: (event: ChatStreamEvent) => void,
  calls: ToolCallRecord[],
  executed: Set<string>
): void {
  for (const call of calls) {
    if (executed.has(call.id)) continue
    const toolMessageId = store.addToolMessage(scope, call.id, UNEXECUTED_RESULT)
    emit({
      type: 'tool_result',
      scope,
      toolMessageId,
      callId: call.id,
      result: UNEXECUTED_RESULT,
      ok: false
    })
  }
}

/** 有任何内容就写回占位行,否则删除 */
function persistStep(
  store: AgentStore,
  messageId: string,
  content: string,
  reasoning: string,
  calls: ToolCallRecord[],
  usage: TokenUsage
): void {
  try {
    if (content || reasoning || calls.length > 0) {
      store.updateStep(messageId, content, reasoning, calls, usage)
    } else {
      store.removeStep(messageId)
    }
  } catch (error) {
    // 会话已被删除(级联删掉了占位行)等情况下写库失败不影响主流程
    console.error('[agent] persist step failed:', error)
  }
}

/**
 * 端点报了 usage 就以它为准,没报才退回估算并标注 estimated。
 * 界面据此决定显示「12.3k」还是「≈12.3k」—— 混在一起看会误导人对预算的信任度。
 */
function toUsage(
  reported: ReportedUsage | undefined,
  estimatedPrompt: number,
  estimatedCompletion: number
): TokenUsage {
  if (reported) return { ...reported, estimated: false }
  return { prompt: estimatedPrompt, completion: estimatedCompletion, estimated: true }
}
