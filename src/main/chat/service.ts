import { v4 as uuidv4 } from 'uuid'
import type Database from 'better-sqlite3'
import { getDb } from '../database/index'
import { store } from '../store'
import {
  findProvider,
  findProviderByName,
  listProviders,
  resolveConnection
} from '../store/providers'
import { normalizeRef } from '../store/modelRef'
import type { ModelRef } from '../store/types'
import { chatSql, type Conversation, type Message, type MessageRow } from './sql'
import type {
  createFirstMessageDto,
  sendMessageDto,
  generateReplyDto,
  ChatStreamEvent,
  RunScope,
  ToolCallRecord
} from './dto'
import { runAgent, MAIN_AGENT_MAX_STEPS, type AgentStore } from '../agent/loop'
import { buildHistory, skillsCatalog } from '../agent/history'
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
function parseToolCalls(raw: string): ToolCallRecord[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as ToolCallRecord[]) : []
  } catch {
    return []
  }
}

/** 数据库行 → 对外消息(tool_calls 解析成数组) */
function toMessage(row: MessageRow): Message {
  return { ...row, tool_calls: parseToolCalls(row.tool_calls) }
}

/** 整段会话的全部消息(含子 agent 的嵌套行),供渲染层还原嵌套结构 */
export function listMessages(conversationId: string): Message[] {
  return getDb()
    .prepare<[string], MessageRow>(chatSql.messages.list)
    .all(conversationId)
    .map(toMessage)
}

/**
 * Agent 历史用的消息列表:只取顶层行。
 * 子 agent 的行挂在父级 task 调用下,回放时必须排除,否则会出现孤儿 tool 行。
 */
export function listTopLevelMessages(conversationId: string): Message[] {
  return getDb()
    .prepare<[string], MessageRow>(chatSql.messages.listTopLevel)
    .all(conversationId)
    .map(toMessage)
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

  const createChat = getDb().transaction(() => {
    createConversation(conversationId, title)
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
  updateStep: (messageId, content, reasoning, calls) => {
    if (quitting) return
    getDb()
      .prepare(chatSql.messages.updateStep)
      .run(content, reasoning, JSON.stringify(calls), messageId)
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
      model: role.model ?? (roleProvider ? roleProvider.models[0] : ctx.parentRef.model)
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
        { role: 'system', content: role.systemPrompt + (canLoadSkills ? skillsCatalog() : '') },
        { role: 'user', content: req.prompt }
      ],
      runner,
      maxSteps: SUB_AGENT_MAX_STEPS,
      store: agentStore,
      emit: ctx.emit
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
  const { baseUrl, apiKey, model } = resolveConnection(ref)

  const messages = listTopLevelMessages(dto.conversationId)
  if (!messages.some((m) => m.role === 'user')) throw new Error('会话不存在或没有可发送的消息')

  const runId = uuidv4()
  const controller = new AbortController()
  activeRuns.set(runId, { conversationId: dto.conversationId, controller })

  // 工具快照在 run 开始时固定,保证本次 run 的执行范围与发给模型的列表严格一致
  const definitions = getAllTools()
  const tools = [...definitions]

  // 允许派生子 Agent 时,给主 agent 挂上 task 工具(子 agent 自己拿不到它)
  if (store.get('enableSubAgent') !== false) {
    tools.push(
      createTaskTool(
        createSubAgentSpawner({
          conversationId: dto.conversationId,
          runId,
          parentRef: ref,
          signal: controller.signal,
          parentTools: definitions,
          emit
        }),
        // 与 system prompt 里的角色目录取同一份名单,保证 schema 与提示词一致
        { agents: agentRegistry.getEnabledCustom().map((a) => a.name) }
      )
    )
  }

  void runAgent({
    scope: {
      conversationId: dto.conversationId,
      runId,
      agent: '',
      parentCallId: '',
      depth: 0
    },
    baseUrl,
    apiKey,
    model,
    signal: controller.signal,
    history: buildHistory(messages, definitions),
    runner: createToolRunner(tools),
    maxSteps: MAIN_AGENT_MAX_STEPS,
    store: agentStore,
    emit
  }).finally(() => {
    activeRuns.delete(runId)
  })

  return runId
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
