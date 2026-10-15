import { v4 as uuidv4 } from 'uuid'
import type Database from 'better-sqlite3'
import { getDb } from '../database/index'
import { store } from '../store'
import {
  findProvider,
  findProviderByName,
  listProviders,
  resolveConnection,
  type ResolvedConnection
} from '../store/providers'
import { normalizeRef } from '../store/modelRef'
import type { ModelRef } from '../store/types'
import { chatSql, type Conversation, type Message, type MessageRow } from './sql'
import type {
  createFirstMessageDto,
  sendMessageDto,
  generateReplyDto,
  compactDto,
  ChatStreamEvent,
  CompactReport,
  RunScope,
  SummaryMetrics,
  ToolCallRecord
} from './dto'
import {
  runAgent,
  MAIN_AGENT_MAX_STEPS,
  type AgentStore,
  type RunCompactResult,
  type RunCompactor
} from '../agent/loop'
import { budgetFor } from '../agent/context'
import {
  DEFAULT_COMPACT_POLICY,
  compactConversation,
  planCompaction,
  toCompactUnits,
  type CompactSizing,
  type CompactUnit
} from '../agent/compact'
import {
  buildHistory,
  historyBody,
  skillsCatalog,
  systemPromptMessage,
  toIdentifiedMessages
} from '../agent/history'
import { workspaceNote } from '../agent/prompt'
import {
  createTaskTool,
  TASK_TOOL_NAME,
  SUB_AGENT_MAX_STEPS,
  SUB_AGENT_RESULT_MAX,
  type SpawnRequest,
  type SubAgentSpawner
} from '../agent/task'
import { agentRegistry } from '../agents/registry'
import { GENERIC_AGENT } from '../agents/builtin'
import { loadSkillTool } from '../skills/tools'
import { estimateRequestTokens, estimateTextTokens } from '../tokens/estimate'
import {
  createToolRunner,
  getAllTools,
  type ToolContext,
  type ToolDefinition
} from '../tools/registry'

interface ActiveRun {
  conversationId: string
  controller: AbortController
}

/** 进行中的 Agent run,key 为 runId */
const activeRuns = new Map<string, ActiveRun>()
/** 应用退出中:不再写库 */
let quitting = false

export function listConversations(): Conversation[] {
  return getDb().prepare<[], Conversation>(chatSql.conversations.list).all()
}

export function createConversation(id: string, title: string): Database.RunResult {
  return getDb().prepare(chatSql.conversations.create).run(id, title)
}

export function renameConversation(id: string, title: string): Database.RunResult {
  return getDb().prepare(chatSql.conversations.rename).run(title, id)
}

export function removeConversation(id: string): Database.RunResult {
  // 该会话若有进行中的 run 先中止,避免删除后继续写库
  for (const run of activeRuns.values()) {
    if (run.conversationId === id) run.controller.abort()
  }
  return getDb().prepare(chatSql.conversations.remove).run(id)
}

export function resortConversation(id: string): Database.RunResult {
  return getDb().prepare(chatSql.conversations.resort).run(id)
}

/** 解析 tool_calls JSON 列;损坏时当作没有 */
export function parseToolCalls(raw: string): ToolCallRecord[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as ToolCallRecord[]) : []
  } catch {
    return []
  }
}

/** 数据库行 → 对外消息(tool_calls 解析成数组) */
export function rowToMessage(row: MessageRow): Message {
  return { ...row, tool_calls: parseToolCalls(row.tool_calls) }
}

/** 整段会话的全部消息(含子 agent 的嵌套行),供渲染层还原嵌套结构 */
export function listMessages(conversationId: string): Message[] {
  return getDb()
    .prepare<[string], MessageRow>(chatSql.messages.list)
    .all(conversationId)
    .map(rowToMessage)
}

/**
 * Agent 历史用的消息列表:只取顶层行。
 * 子 agent 的行挂在父级 task 调用下,回放时必须排除,否则会出现孤儿 tool 行。
 */
export function listTopLevelMessages(conversationId: string): Message[] {
  return getDb()
    .prepare<[string], MessageRow>(chatSql.messages.listTopLevel)
    .all(conversationId)
    .map(rowToMessage)
}

/** 一个会话的摘要状态;`summaryUntil` 为空串表示还没压过,历史仍全量回放 */
export interface SummaryState {
  summary: string
  summaryUntil: string
  metrics: SummaryMetrics | undefined
}

interface SummaryStateRow {
  summary: string
  summary_until: string
  summary_usage: string
}

/**
 * 解析 `summary_usage` 列。
 * 账目只用于界面解释「上次压了什么、省了多少」,所以字段缺成什么样都不值得报错 ——
 * 形状不对或 JSON 损坏一律当作没有,让占用环退回只显示当前用量。
 */
export function parseSummaryMetrics(raw: string): SummaryMetrics | undefined {
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const m = parsed as Partial<SummaryMetrics>
  if (typeof m.prompt !== 'number' || typeof m.completion !== 'number') return undefined
  return {
    prompt: m.prompt,
    completion: m.completion,
    estimated: m.estimated === true,
    coveredMessages: typeof m.coveredMessages === 'number' ? m.coveredMessages : 0,
    coveredTokens: typeof m.coveredTokens === 'number' ? m.coveredTokens : 0,
    at: typeof m.at === 'string' ? m.at : ''
  }
}

/** 读摘要三列;会话不存在时给出「没有摘要」的空形状,而不是抛错 */
export function getSummaryState(conversationId: string): SummaryState {
  const row = getDb()
    .prepare<[string], SummaryStateRow>(chatSql.conversations.summaryState)
    .get(conversationId)
  return {
    summary: row?.summary ?? '',
    summaryUntil: row?.summary_until ?? '',
    metrics: parseSummaryMetrics(row?.summary_usage ?? '')
  }
}

/**
 * 会话的工作空间目录;没选(或会话不存在)返回空串 —— 工具据此退回应用当前目录。
 * 一个 run 只在 startRun 读一次,好让整轮的相对路径落在同一个目录上。
 */
export function getWorkspace(conversationId: string): string {
  const row = getDb()
    .prepare<[string], { workspace: string }>(chatSql.conversations.workspace)
    .get(conversationId)
  return row?.workspace ?? ''
}

/**
 * 设置会话的工作空间。
 * 与摘要一样不动 updated_at:换目录不是对话活动,不该把会话顶到列表最前。
 */
export function setConversationWorkspace(
  conversationId: string,
  workspace: string
): Database.RunResult {
  return getDb().prepare(chatSql.conversations.setWorkspace).run(workspace.trim(), conversationId)
}

/**
 * 水位之后的顶层行:压缩后发给模型的那段历史(不含子 agent 的嵌套行)。
 * 没有水位时这条 SQL 退化成全量顶层行,所以调用方不需要分支。
 */
export function listMessagesAfterWatermark(conversationId: string): Message[] {
  const { summaryUntil } = getSummaryState(conversationId)
  return getDb()
    .prepare<[string, string], MessageRow>(chatSql.messages.listTopLevelAfter)
    .all(conversationId, summaryUntil)
    .map(rowToMessage)
}

/**
 * 记下一次压缩的结果。
 * 只有摘要真正产出并写进请求时才调用;失败或被中止的压缩保持原水位,
 * 下一次请求照旧回放全部历史 —— 宁可超限也不悄悄丢内容。
 */
export function commitSummary(
  conversationId: string,
  summary: string,
  untilMessageId: string,
  metrics: SummaryMetrics
): Database.RunResult {
  return getDb()
    .prepare(chatSql.conversations.setSummary)
    .run(summary, untilMessageId, JSON.stringify(metrics), conversationId)
}

/** 压缩一组单元所需的模型调用参数 */
interface CompactTarget {
  baseUrl: string
  apiKey?: string
  model: string
  signal: AbortSignal
}

/**
 * `compactUnits` 的结果:面向界面的报告,外加 run 中途续跑要用的两样东西。
 *
 * 摘要正文与「覆盖了几个单元」只有 loop 需要(它得就地换掉固定头部、切掉前缀);
 * 走 IPC 的那条路径会把它们摘掉 —— 摘要已经在库里,再发给渲染层只是白占一次序列化。
 */
type UnitCompactResult = CompactReport & RunCompactResult

/** 摘掉 loop 专用的内部字段,得到可以直接过 IPC 的报告 */
function toReport({ summary, coveredUnits, ...rest }: UnitCompactResult): CompactReport {
  void summary
  void coveredUnits
  return rest
}

/**
 * 把「水位之后的单元」压一次:选边界 → 分段摘要 → 写摘要与水位。
 *
 * 边界与摘要都由 agent/compact.ts 决定,这里只做编排:
 *   - 计划拒绝(含手动压缩时的收益不足)不调模型,直接返回原因;
 *   - 摘要失败或中止**不写水位**,历史原样留着 —— 用半截摘要冒充完整摘要比超窗更难排查。
 * running 的 run 与手动按钮可能同时想压同一个会话,互斥由调用方持有的 Set 保证。
 */
async function compactUnits(
  target: CompactTarget,
  conversationId: string,
  units: CompactUnit[],
  sizing: CompactSizing,
  options: { force: boolean; summary: string; stateNote?: string }
): Promise<UnitCompactResult> {
  const decision = planCompaction(units, sizing, DEFAULT_COMPACT_POLICY, options.force)
  if (!decision.should) {
    return { compacted: false, reason: decision.reason, window: sizing.window }
  }

  const outcome = await compactConversation({
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    model: target.model,
    signal: target.signal,
    previousSummary: options.summary,
    plan: decision.plan,
    ...(options.stateNote ? { stateNote: options.stateNote } : {})
  })

  if (!outcome.ok) {
    return {
      compacted: false,
      ...(outcome.msg ? { msg: outcome.msg } : {}),
      usage: outcome.usage,
      window: sizing.window
    }
  }

  const metrics = outcome.metrics as SummaryMetrics
  commitSummary(conversationId, outcome.summary, outcome.untilMessageId, metrics)
  return {
    compacted: true,
    summary: outcome.summary,
    coveredUnits: decision.plan.covered.length,
    usage: outcome.usage,
    metrics,
    projectedTokens: decision.plan.projectedTokens,
    window: sizing.window
  }
}

/**
 * 压缩判断所需的规模:固定开销 + 当前摘要 + 模型配置的窗口。
 * 固定开销的口径必须与 planContext 一致(同一份 system prompt 与工具定义),所以现取而不另算 ——
 * 两处一旦分叉,触发线就算歪,要么早压要么压不动。
 */
function fixedSizing(
  definitions: ToolDefinition[],
  contextWindow: number | undefined,
  summary: string,
  workspace: string
): CompactSizing {
  const tools = createToolRunner(definitions).toChatCompletionTools()
  return {
    fixedTokens: estimateRequestTokens(buildHistory([], definitions, '', workspace), tools),
    summaryTokens: estimateTextTokens(summary),
    // 压缩的比例全部相对「模型配置的窗口」,不是相对裁剪后的额度
    window: budgetFor(contextWindow).window
  }
}

/** 正在压缩中的会话:同一会话同时只允许一次压缩 */
const compacting = new Set<string>()

/**
 * 该会话是否有进行中的 run 或压缩;手动压缩与切换工作空间都只在两皆无时才允许。
 * 两者都在推进会话级的状态(水位 / 相对路径基准),与正在跑的 run 并发会互相踩出错误结果。
 */
export function hasActiveWork(conversationId: string): boolean {
  if (compacting.has(conversationId)) return true
  for (const run of activeRuns.values()) {
    if (run.conversationId === conversationId) return true
  }
  return false
}

/**
 * 对「水位之后的全部顶层行」压一次。
 * 请求前的自动压缩与手动压缩共用它,两者只在 force 上不同。
 */
async function compactBeforeRun(
  target: CompactTarget,
  conversationId: string,
  definitions: ToolDefinition[],
  options: { force: boolean; summary: string; contextWindow?: number; workspace: string }
): Promise<UnitCompactResult> {
  const messages = listMessagesAfterWatermark(conversationId)
  const units = toCompactUnits(toIdentifiedMessages(messages, definitions))
  return compactUnits(
    target,
    conversationId,
    units,
    fixedSizing(definitions, options.contextWindow, options.summary, options.workspace),
    { force: options.force, summary: options.summary }
  )
}

/**
 * run 中途的压缩:loop 每一步之后问一次「该压了吗」。
 *
 * 与请求前的压缩走同一个 `compactUnits`,差别只在两件事:
 *   - 单元与规模由 loop 现算 —— 它手里就是下一步要发出去的那份上下文,包含本轮自己攒的
 *     工具结果,这部分请求前的压缩看不见;
 *   - 必须带执行状态便签(`note`):摘要要写下「已经做过什么、还剩几步」,否则压完续跑会把
 *     做过的工具再调一遍。
 * 没越过触发线时计划直接拒绝,不发模型调用,loop 拿到 compacted=false 就原样继续。
 * 子 Agent 不传这个注入点:它的上下文就是自己那份任务,压掉的过程它自己还要用。
 */
function createRunCompactor(
  conversationId: string,
  connection: ResolvedConnection,
  signal: AbortSignal
): RunCompactor {
  return async ({ units, sizing, summary, note }) => {
    const result = await compactUnits(
      { baseUrl: connection.baseUrl, apiKey: connection.apiKey, model: connection.model, signal },
      conversationId,
      units,
      sizing,
      { force: false, summary, stateNote: note }
    )
    return {
      compacted: result.compacted,
      ...(result.summary === undefined ? {} : { summary: result.summary }),
      ...(result.coveredUnits === undefined ? {} : { coveredUnits: result.coveredUnits }),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      ...(result.metrics === undefined ? {} : { metrics: result.metrics }),
      ...(result.msg === undefined ? {} : { msg: result.msg })
    }
  }
}

/**
 * 手动压缩一次会话的上下文(上下文占用环上的按钮走这条路径)。
 *
 * 与请求前的自动压缩只差一个 force:用户已经决定要压,触发线不再拦。
 * 单元数与收益不足照样拒 —— 那种情况下按了也省不出空间,得让用户看到原因。
 * 不能与正在跑的 run 并存:两边都在推进同一个水位,会互相踩出错误的边界。
 */
export async function compactConversationManually(dto: compactDto): Promise<CompactReport> {
  const ref: ModelRef | undefined = dto.providerId
    ? { providerId: dto.providerId, model: dto.model }
    : normalizeRef(store.get('currentModel'), listProviders())
  if (!ref) throw new Error('请先在设置中配置模型服务商')
  const connection = resolveConnection(ref)
  if (hasActiveWork(dto.conversationId)) {
    throw new Error('这一轮还在进行中,请等它结束或先点击停止')
  }

  // 登记进 activeRuns:应用退出或删除会话时,这条摘要调用同样会被中止
  const controller = new AbortController()
  const runId = uuidv4()
  activeRuns.set(runId, { conversationId: dto.conversationId, controller })
  compacting.add(dto.conversationId)
  try {
    const { summary } = getSummaryState(dto.conversationId)
    const result = await compactBeforeRun(
      {
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
        model: connection.model,
        signal: controller.signal
      },
      dto.conversationId,
      getAllTools(),
      {
        force: true,
        summary,
        contextWindow: connection.contextWindow,
        workspace: getWorkspace(dto.conversationId)
      }
    )
    return toReport(result)
  } finally {
    compacting.delete(dto.conversationId)
    activeRuns.delete(runId)
  }
}

export function createMessage(
  messageId: string,
  conversationId: string,
  role: Message['role'],
  content: string,
  skill = ''
): Database.RunResult {
  return getDb().prepare(chatSql.messages.add).run(messageId, conversationId, role, content, skill)
}

export function removeMessage(id: string): Database.RunResult {
  return getDb().prepare(chatSql.messages.removeById).run(id)
}

export function createFirstMessage(dto: createFirstMessageDto): string {
  const conversationId = uuidv4()
  const messageId = uuidv4()

  const title = dto.content.length > 20 ? dto.content.substring(0, 20) + '...' : dto.content
  // 草稿期选好的工作空间随新会话一起落库:此后每次 run 只读会话那一列,
  // 全局那个值只是「下一段新对话用什么」的待用值,不参与已有会话
  const workspace = (store.get('defaultWorkspace') ?? '').trim()

  const createChat = getDb().transaction(() => {
    createConversation(conversationId, title)
    if (workspace) setConversationWorkspace(conversationId, workspace)
    createMessage(messageId, conversationId, 'user', dto.content, dto.skill ?? '')
  })

  createChat()

  return conversationId
}

export function sendMessage(dto: sendMessageDto): string {
  const messageId = uuidv4()

  const appendMessage = getDb().transaction(() => {
    createMessage(messageId, dto.conversationId, 'user', dto.content, dto.skill ?? '')
    resortConversation(dto.conversationId)
  })

  appendMessage()

  return messageId
}

/** Agent loop 使用的落库实现;退出中时静默跳过写操作 */
const agentStore: AgentStore = {
  addStep: (scope: RunScope) => {
    const id = uuidv4()
    getDb()
      .prepare(chatSql.messages.addAssistantStep)
      .run(id, scope.conversationId, scope.runId, scope.agent, scope.parentCallId, scope.depth)
    return id
  },
  updateStep: (messageId, content, reasoning, calls, usage) => {
    if (quitting) return
    getDb()
      .prepare(chatSql.messages.updateStep)
      .run(
        content,
        reasoning,
        JSON.stringify(calls),
        usage.prompt,
        usage.completion,
        usage.estimated ? 1 : 0,
        messageId
      )
  },
  removeStep: (messageId) => {
    if (quitting) return
    removeMessage(messageId)
  },
  addToolMessage: (scope: RunScope, toolCallId, content) => {
    const id = uuidv4()
    if (quitting) return id
    getDb()
      .prepare(chatSql.messages.addToolMessage)
      .run(
        id,
        scope.conversationId,
        content,
        toolCallId,
        scope.runId,
        scope.agent,
        scope.parentCallId,
        scope.depth
      )
    return id
  },
  touchConversation: (conversationId) => {
    if (quitting) return
    try {
      resortConversation(conversationId)
    } catch (error) {
      console.error('[chat] touch conversation failed:', error)
    }
  }
}

/** 超出上限时截断,并明确告知主 Agent 结果不完整 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[结果过长已截断,以上为前 ${max} 字]`
}

/**
 * 按白名单裁剪工具池:每个非空白名单都要包含该工具(交集语义)。
 * 全部白名单为空时返回原池。MCP 断连等情况导致的名字失效会在这里被静默过滤掉。
 */
function filterTools(
  pool: ToolDefinition[],
  whitelists: (string[] | undefined)[]
): ToolDefinition[] {
  const active = whitelists.filter((w): w is string[] => Array.isArray(w) && w.length > 0)
  if (active.length === 0) return pool
  return pool.filter((t) => active.every((names) => names.includes(t.name)))
}

interface SpawnerContext {
  conversationId: string
  runId: string
  /** 父级(主 agent)本次使用的模型选择,子 agent 默认整套继承 */
  parentRef: ModelRef
  signal: AbortSignal
  /** 主 agent 的可用工具,子 agent 在此基础上裁剪 */
  parentTools: ToolDefinition[]
  /**
   * 父级本次 run 的工作空间,子 Agent 整套继承:主 agent 给的相对路径就是相对这个目录,
   * 两边基准不同会让子 Agent 读到别的文件,而它回传的结论父级无从校验。
   */
  workspace: string
  emit: (event: ChatStreamEvent) => void
}

/** 构造 task 工具的 spawner:跑一次独立上下文的子 agent run,返回它的最终结论 */
function createSubAgentSpawner(ctx: SpawnerContext): SubAgentSpawner {
  return async (req: SpawnRequest, call: ToolContext): Promise<string> => {
    const requested = agentRegistry.resolve(req.agent)
    // 角色名是模型自己填的,抄错或凭空编一个都可能。整个子任务不该为此失败 ——
    // 用户要的是"派个子 Agent 把事办了",回退到通用角色比直接报错更符合意图。
    if (!requested && req.agent) {
      console.warn(`[agent] 未知的子 Agent 角色 "${req.agent}",已回退到通用子 Agent`)
    }
    const role = requested ?? GENERIC_AGENT
    if (!role.enabled) throw new Error(`子 Agent 角色 "${role.name}" 已被禁用`)

    // 角色可以指定服务商(按名字);指定不到就回退父级那家,不让整轮子任务失败。
    // 换了服务商却没指定模型时,用新服务商的首个模型 —— 父级那个多半不属于它。
    const roleProvider = role.provider ? findProviderByName(role.provider) : undefined
    if (role.provider && !roleProvider) {
      console.warn(
        `[agent] 角色 "${role.name}" 指定的服务商 "${role.provider}" 不存在,已回退到父级服务商`
      )
    }
    const targetProvider = roleProvider ?? findProvider(ctx.parentRef.providerId)
    if (!targetProvider) throw new Error('父级服务商已不存在,无法派生子 Agent')
    const connection = resolveConnection({
      providerId: targetProvider.id,
      // 新服务商一个模型都没填时退回父级那个,总比把 undefined 当模型名发出去好
      model: role.model ?? roleProvider?.models[0]?.name ?? ctx.parentRef.model
    })

    const scope: RunScope = {
      conversationId: ctx.conversationId,
      // 沿用父级 run_id:前端据此把子 agent 的行并进同一个助手气泡
      runId: ctx.runId,
      // 通用角色不带名字,界面上不显示多余的角色标注
      agent: role.builtin ? '' : role.name,
      parentCallId: call.callId,
      depth: 1
    }

    // 显式剔除 task:即便将来它被挪进 builtinTools,子 agent 也无法再派生
    const pool = ctx.parentTools.filter((t) => t.name !== TASK_TOOL_NAME)
    // 角色白名单与模型本次指定的白名单取交集
    const tools = filterTools(pool, [role.tools, req.tools])
    const runner = createToolRunner(tools)
    // 只有真拿得到 load_skill 时才给它 skill 目录,避免提示词与实际工具不一致
    const canLoadSkills = tools.some((t) => t.name === loadSkillTool.name)

    const result = await runAgent({
      scope,
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      model: connection.model,
      // 复用父级 signal:用户停止或删除会话时父子一起停
      signal: ctx.signal,
      history: [
        {
          role: 'system',
          content:
            role.systemPrompt +
            workspaceNote(ctx.workspace) +
            (canLoadSkills ? skillsCatalog() : '')
        },
        { role: 'user', content: req.prompt }
      ],
      runner,
      // 与父级同一个目录:主 Agent 派任务时写的相对路径就是这个目录
      workspace: ctx.workspace,
      maxSteps: SUB_AGENT_MAX_STEPS,
      store: agentStore,
      emit: ctx.emit,
      // 按子 Agent 自己那个模型的窗口裁剪:角色的 AGENT.md 可以指定别的模型,
      // 沿用父级的窗口就会算错预算
      budget: budgetFor(connection.contextWindow)
    })

    if (result.error && !result.finalContent) {
      throw new Error(`子 Agent 执行失败:${result.error}`)
    }
    if (!result.finalContent.trim()) {
      return result.aborted ? '子 Agent 已被中止。' : '子 Agent 未产出任何结论。'
    }
    return truncate(result.finalContent, SUB_AGENT_RESULT_MAX)
  }
}

/**
 * 启动一次 Agent run:基于会话历史让模型推理、调用工具、生成最终回复。
 * 同步返回 runId,过程在后台进行,各步事件通过 emit 推送。
 */
export function generateReply(
  dto: generateReplyDto,
  emit: (event: ChatStreamEvent) => void
): string {
  if (!dto.model) throw new Error('请先选择模型')
  // 单次 run 以调用方显式传入的选择为准;没传就退回设置里上次选中的那个
  const ref: ModelRef | undefined = dto.providerId
    ? { providerId: dto.providerId, model: dto.model }
    : normalizeRef(store.get('currentModel'), listProviders())
  if (!ref) throw new Error('请先在设置中配置模型服务商')
  // 连接在 run 开始前解析一次并随参数带走:过程中改设置不影响这一轮
  const connection = resolveConnection(ref)

  const messages = listTopLevelMessages(dto.conversationId)
  if (!messages.some((m) => m.role === 'user')) throw new Error('会话不存在或没有可发送的消息')

  const runId = uuidv4()
  const controller = new AbortController()
  activeRuns.set(runId, { conversationId: dto.conversationId, controller })

  void startRun({
    conversationId: dto.conversationId,
    scope: {
      conversationId: dto.conversationId,
      runId,
      agent: '',
      parentCallId: '',
      depth: 0
    },
    ref,
    connection,
    signal: controller.signal,
    emit
  }).finally(() => {
    activeRuns.delete(runId)
  })

  return runId
}

interface StartRunInput {
  conversationId: string
  scope: RunScope
  ref: ModelRef
  connection: ResolvedConnection
  signal: AbortSignal
  emit: (event: ChatStreamEvent) => void
}

/**
 * 压缩检查 → 组装历史 → 跑 run。
 *
 * 这一段是异步的,而 `generateReply` 必须同步返回 runId(渲染层先拿到句柄才能订阅事件),
 * 所以拆开。放在 run 之前是因为压缩自己就是一次模型调用:本轮就该受益于新摘要,
 * 而不是「这轮还带着全部历史、下轮才用上摘要」。
 */
async function startRun(input: StartRunInput): Promise<void> {
  const { conversationId, scope, connection, signal, emit } = input
  const { baseUrl, apiKey, model, contextWindow } = connection
  // 工作空间在 run 开始前读一次并随整轮带走:中途改设置不影响这一轮,
  // 而且相对路径的基准必须在整轮里稳定,否则上一条工具结果指的文件会换含义
  const workspace = getWorkspace(conversationId)
  // 工具快照在 run 开始时固定,保证本次 run 的执行范围与发给模型的列表严格一致
  const definitions = getAllTools()

  const tools = [...definitions]
  // 允许派生子 Agent 时,给主 agent 挂上 task 工具(子 agent 自己拿不到它)
  if (store.get('enableSubAgent') !== false) {
    tools.push(
      createTaskTool(
        createSubAgentSpawner({
          conversationId,
          runId: scope.runId,
          parentRef: input.ref,
          signal,
          parentTools: definitions,
          workspace,
          emit
        }),
        // 与 system prompt 里的角色目录取同一份名单,保证 schema 与提示词一致
        { agents: agentRegistry.getEnabledCustom().map((a) => a.name) }
      )
    )
  }

  // 请求前自动压缩:没过触发线什么也不做;摘要调用失败也不阻断本轮 ——
  // 带着全部历史继续跑,由 planContext 的硬上限兜底,总比直接拒绝对话好。
  const { summary } = getSummaryState(conversationId)
  const report = await compactBeforeRun({ baseUrl, apiKey, model, signal }, conversationId, tools, {
    force: false,
    summary,
    contextWindow,
    workspace
  })
  // 只有真调过模型才发事件:被计划拒绝时没有任何账目可展示
  if (report.usage) {
    emit({
      type: 'compact',
      scope,
      // 请求前的压缩不属于任何一步,界面把它作为本轮的说明展示
      messageId: '',
      ok: report.compacted,
      usage: report.usage,
      ...(report.metrics ? { metrics: report.metrics } : {}),
      ...(report.msg ? { msg: report.msg } : {})
    })
  }

  // 摘要 + 水位之后的原文:压缩生效后这才是发给模型的历史
  const messages = listMessagesAfterWatermark(conversationId)
  // id 与消息取自同一次转换:loop 中途压缩要把水位落在 id 上,两者必须一一对齐
  const items = toIdentifiedMessages(messages, tools)
  const current = getSummaryState(conversationId).summary
  const history = [systemPromptMessage(workspace), ...historyBody(items, current)]

  await runAgent({
    scope,
    baseUrl,
    apiKey,
    model,
    signal,
    history,
    workspace,
    runner: createToolRunner(tools),
    maxSteps: MAIN_AGENT_MAX_STEPS,
    // 窗口跟着本次解析出的连接走:换服务商 / 换模型都自动跟着变,不再依赖一个全局值
    budget: budgetFor(contextWindow),
    store: agentStore,
    emit,
    // 长工具链会把本轮的工具结果一路堆过触发线,请求前的压缩看不见这部分
    compaction: {
      summary: current,
      historyIds: items.map((item) => item.id),
      run: createRunCompactor(conversationId, connection, signal)
    }
  })
}

/** 中止指定 run */
export function abortReply(runId: string): void {
  activeRuns.get(runId)?.controller.abort()
}

/** 应用退出时中止全部 run,并停止后续写库 */
export function abortAll(): void {
  quitting = true
  for (const run of activeRuns.values()) run.controller.abort()
}
