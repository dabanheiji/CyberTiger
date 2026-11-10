import { PLAN_AGENT_NAME } from '../agents/builtin'
import type { Message } from '../chat/sql'

/**
 * 一份待审批的计划。
 * 它不落盘、也不进内存表 —— 由会话消息现推出来:计划 run 的最终回答就是一条
 * `agent = plan-agent` 的 assistant 行,批准或用户发下一句之后它就不再是「最后一条」,
 * 卡片据此自动消失。重载与重启都靠同一条推导恢复,不需要额外的持久化。
 */
export interface PendingPlan {
  plan: string
  /** 修订次数:第一次生成的草稿是 0,提一次修改意见后是 1 */
  revision: number
  /** 计划落库时刻(毫秒);解析不出来时退回当前时间 */
  createdAt: number
}

function createdAtOf(text: string): number {
  // SQLite 的 CURRENT_TIMESTAMP 是 UTC 文本,直接 Date.parse 会被当成本地时间
  const parsed = Date.parse(`${text.replace(' ', 'T')}Z`)
  return Number.isNaN(parsed) ? Date.now() : parsed
}

/** 只有纯正文的 assistant 行才是计划:带 tool_calls 的那几步是规划过程,不是结论 */
export function isPlanDraft(message: Message): boolean {
  return (
    message.agent === PLAN_AGENT_NAME &&
    message.role === 'assistant' &&
    message.tool_calls.length === 0 &&
    message.content.trim() !== ''
  )
}

/**
 * 从会话消息里推出待审批的那一份计划。
 *
 * 只看**最后一条 user 行之后**的草稿:那条 user 行就是本次需求,它之后的计划才属于
 * 这一问;批准后会写入一条 `[计划执行]` user 行,旧计划因此自动失效,用户忽略计划
 * 直接发一句普通消息也一样 —— 两条路都不需要额外的清理动作。
 */
export function derivePendingPlan(messages: readonly Message[]): PendingPlan | null {
  let lastUser = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      lastUser = index
      break
    }
  }
  if (lastUser < 0) return null

  const drafts = messages.slice(lastUser + 1).filter(isPlanDraft)
  if (drafts.length === 0) return null
  const last = drafts[drafts.length - 1]
  return {
    plan: last.content,
    revision: drafts.length - 1,
    createdAt: createdAtOf(last.created_at)
  }
}
