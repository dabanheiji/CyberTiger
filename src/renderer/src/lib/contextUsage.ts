import type { Message } from '../../../main/chat/sql'
import type { CompactReport, CompactRejectReason } from '../../../main/chat/dto'
import type { ModelProvider, ModelRef } from '../../../main/store/types'
import { contextWindowOf } from '../../../main/store/modelRef'
import { budgetFor } from '../../../main/agent/context'
import { formatTokens } from '../../../main/tokens/estimate'
import type { AgentStep } from './agentSteps'

/**
 * 「当前会话吃掉了多少上下文」的纯计算,和进度条组件分开是为了能被 vitest 直接测。
 * 分母不需要新 IPC:设置里的 providers 与当前选择本来就渲染层手里有。
 */

/** 一次回复(或流式进行中)的输入占用 */
export interface LatestInput {
  used: number
  estimated: boolean
}

/** 进度条与气泡底部共用的那组数 */
export interface ContextUsage extends LatestInput {
  /** 当前模型的窗口大小 */
  window: number
  /** 预算里留给输入的额度:超过它,裁剪就开始动手 */
  trimAt: number
  /** used / window,夹在 0~1 —— 估算误差或窗口配小了都不该显示 137% */
  ratio: number
}

export interface ContextUsageSource {
  /** 正在流式中的 run 的顶层步骤;有它就优先于库里的行 */
  streamingSteps?: AgentStep[]
  messages: Message[]
  providers: ModelProvider[]
  currentRef?: ModelRef
}

/**
 * 顶层步骤里最近一次请求的输入占用。
 * 只看这一层的 steps:子 Agent 用的是另一份上下文,并进主会话的窗口没有意义。
 * 各步的输入是包含关系(第 N 步含前 N-1 步的全部历史),所以取最大值而不是求和。
 */
export function latestInputOfSteps(steps: AgentStep[]): LatestInput | null {
  let used: LatestInput | null = null
  for (const step of steps) {
    if (!step.usage) continue
    if (!used || step.usage.prompt > used.used) {
      used = { used: step.usage.prompt, estimated: step.usage.estimated }
    }
  }
  return used
}

/** 从库里回溯最后一条顶层 assistant 行的用量;老会话没写过用量,一条都没有就返回 null */
export function latestInputOfMessages(messages: Message[]): LatestInput | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant' || m.parent_call_id !== '') continue
    if (m.prompt_tokens === 0 && m.completion_tokens === 0) continue
    return { used: m.prompt_tokens, estimated: m.tokens_estimated === 1 }
  }
  return null
}

/**
 * 组装进度条要的那组数。
 * 没有任何用量数据(新会话、旧会话没计量)或还没选模型时返回 null —— 显示一条空条
 * 比显示 0% 更误导,后者看起来像"还有整个窗口可用"。
 */
export function contextUsage(src: ContextUsageSource): ContextUsage | null {
  if (!src.currentRef) return null
  const latest =
    (src.streamingSteps ? latestInputOfSteps(src.streamingSteps) : null) ??
    latestInputOfMessages(src.messages)
  if (!latest) return null

  const provider = src.providers.find((p) => p.id === src.currentRef?.providerId)
  // 没配窗口就走默认值,与主进程 budgetFor 的兜底完全同一套规则
  const budget = budgetFor(contextWindowOf(provider, src.currentRef.model))
  return {
    ...latest,
    window: budget.window,
    trimAt: budget.input,
    ratio: Math.min(1, Math.max(0, latest.used / budget.window))
  }
}

/** 进度条的颜色分档:接近预算先变黄,超了才变红 */
export function usageLevel(usage: ContextUsage): 'normal' | 'warning' | 'danger' {
  if (usage.used > usage.trimAt) return 'danger'
  if (usage.ratio >= 0.7) return 'warning'
  return 'normal'
}

/**
 * 气泡底部那一段「/131k(9%)」。
 * 没传窗口(或窗口不合法)时返回空串,而不是显示一个凭空的默认值 ——
 * 少了这段说明"这个数没有可信的分母",比编一个分母诚实。
 */
export function contextShare(prompt: number, contextWindow?: number): string {
  if (!contextWindow || contextWindow <= 0) return ''
  return `/${formatTokens(contextWindow)}(${Math.round((prompt / contextWindow) * 100)}%)`
}

/** 计划拒绝压缩的原因 → 给用户看的一句解释 */
export function compactReasonText(reason: CompactRejectReason): string {
  switch (reason) {
    case 'below-trigger':
      return '还没到触发线,这次没有压'
    case 'too-few-units':
      return '能整段交给摘要的历史太少(不足 3 组),压了省不出空间'
    case 'poor-saving':
      return '摘要装不下多少内容,压完省不出足够空间'
  }
}

/** 一次压缩结论(手动按钮的返回值)→ 一行说明 */
export function compactResultLine(report: CompactReport): string {
  if (!report.compacted) {
    if (report.msg) return `压缩失败:${report.msg}`
    return report.reason ? compactReasonText(report.reason) : '这次没有压缩'
  }
  const saved = report.metrics ? formatTokens(report.metrics.coveredTokens) : ''
  const projected =
    typeof report.projectedTokens === 'number'
      ? `,压完约 ${formatTokens(report.projectedTokens)}`
      : ''
  return `已压进摘要${saved ? `、省下 ${saved}` : ''}${projected}`
}
