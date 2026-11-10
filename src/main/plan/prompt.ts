import { PLAN_AGENT_SYSTEM_PROMPT, modelNote, workspaceNote } from '../agent/prompt'
import { skillsCatalog } from '../agent/history'
import type { ChatCompletionMessage } from '../chat/llm'
import type { Message } from '../chat/sql'
import type { ResolvedConnection } from '../store/providers'
import { PLAN_AGENT_NAME } from '../agents/builtin'

/**
 * 最近上下文摘要的预算。
 *
 * 规划只需要「我们刚才在聊什么、这次要改哪一块」,不需要整段历史:
 * 把完整历史塞进去,计划 Agent 会开始复述对话而不是看代码。8000 字足够装下最近
 * 十来轮问答,单条 1200 字挡住那种一次贴几千行的消息。
 */
export interface DigestOptions {
  maxChars?: number
  maxMessages?: number
  perMessage?: number
}

const DIGEST_DEFAULTS = { maxChars: 8000, maxMessages: 30, perMessage: 1200 }

interface DigestEntry {
  label: string
  body: string
}

/**
 * 从会话消息里取一段「最近聊了什么」。
 *
 * 只取 user / assistant 的正文:tool 行是执行细节(读过的文件内容会把预算吃光),
 * 而 `agent = plan-agent` 的已有草稿属于上一次规划,把旧计划当上下文会让新计划照着
 * 旧结论写。从最新往回取,超出预算就丢最旧的并写明丢了多少 —— 静默截断会让模型
 * 以为这就是全部。
 */
export function recentContextDigest(
  messages: readonly Message[],
  options: DigestOptions = {}
): string {
  const maxChars = options.maxChars ?? DIGEST_DEFAULTS.maxChars
  const maxMessages = options.maxMessages ?? DIGEST_DEFAULTS.maxMessages
  const perMessage = options.perMessage ?? DIGEST_DEFAULTS.perMessage

  const eligible: DigestEntry[] = []
  for (const message of messages) {
    if (message.agent === PLAN_AGENT_NAME) continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const body = message.content.trim()
    if (!body) continue
    const clipped =
      body.length > perMessage ? `${body.slice(0, perMessage)}(该条消息较长,此处已截断)` : body
    eligible.push({ label: message.role === 'user' ? '用户' : '助手', body: clipped })
  }
  if (eligible.length === 0) return ''

  const kept: DigestEntry[] = []
  let chars = 0
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    if (kept.length >= maxMessages) break
    const entry = eligible[index]
    if (kept.length > 0 && chars + entry.body.length > maxChars) break
    kept.push(entry)
    chars += entry.body.length
  }
  kept.reverse()

  const omitted = eligible.length - kept.length
  const lines = kept.map((entry) => `[${entry.label}] ${entry.body}`)
  if (omitted > 0) lines.unshift(`(更早的 ${omitted} 条消息已省略)`)
  return `## 最近的对话上下文\n${lines.join('\n\n')}`
}

/** 第一次规划:摘要 + 本次需求 */
export function planRequestMessage(digest: string, requirement: string): ChatCompletionMessage {
  const parts: string[] = []
  if (digest.trim()) parts.push(digest.trim())
  parts.push(`## 本次需求\n${requirement.trim()}`)
  return { role: 'user', content: parts.join('\n\n') }
}

/** 修订:摘要 + 本次需求 + 上一版计划 + 修改意见 */
export function revisionRequestMessage(
  digest: string,
  requirement: string,
  previousPlan: string,
  feedback: string
): ChatCompletionMessage {
  const parts: string[] = []
  if (digest.trim()) parts.push(digest.trim())
  parts.push(`## 本次需求\n${requirement.trim()}`)
  parts.push(`## 上一版计划\n${previousPlan.trim()}`)
  parts.push(`## 用户的修改意见\n${feedback.trim()}`)
  return { role: 'user', content: parts.join('\n\n') }
}

/**
 * 批准之后交给主 Agent 的那条 user 消息。
 *
 * 计划正文整份写在这里而不是让主 Agent 去读文件:执行者不必再花一步读文件,
 * 也不会因为文件被移动而拿不到计划。两个路径同时给出,`plan_tasks` 写哪一份是
 * 审批时就已经定下的。
 */
export function planExecutionMessage(input: {
  planPath: string
  taskPath: string
  plan: string
}): string {
  return [
    '[计划执行]',
    '用户已经批准下面的实施计划。现在开始按它执行。',
    '',
    `计划文件:${input.planPath}`,
    `任务文件:${input.taskPath}`,
    '',
    '执行要求:',
    '1. 第一步先调用 plan_tasks,把计划里的实施步骤拆成一条条可逐项完成的条目,写进任务文件。任务文件由 plan_tasks 写,不要用 write_file。',
    '2. 每完成一步,立刻调用 plan_tasks 用 done 勾掉对应序号,并检查还有哪些条目未完成。',
    '3. 严格按计划执行:不跳过步骤,不新增计划外的工作。计划确实需要调整时,先向用户说明原因并征求同意。',
    '4. 全部条目完成后,用几句话总结做了什么、改了哪些文件、验证结果如何。',
    '',
    '## 计划正文',
    input.plan.trim()
  ].join('\n')
}

/**
 * 计划 run 的 system 消息。
 *
 * 与主 Agent 那份的区别:没有子 Agent 目录(它拿不到 task 工具),没有审批 / 钩子说明
 * (计划 run 不装那两道),只留工作空间、本次模型与 skill 目录 —— 后者是有用的,
 * 项目里可能已经有描述这次改动约定的 skill。
 */
export function planSystemMessage(
  workspace = '',
  confined = false,
  execConfined = false,
  connection?: ResolvedConnection
): ChatCompletionMessage {
  return {
    role: 'system',
    content:
      PLAN_AGENT_SYSTEM_PROMPT +
      workspaceNote(workspace, confined, execConfined) +
      modelNote(connection) +
      skillsCatalog(workspace)
  }
}
