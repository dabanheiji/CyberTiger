import type { AskUserAnswer } from './dto'

/**
 * 等待用户回答的提问。
 *
 * `ask_user` 工具会把问题发给渲染层然后**等**着:模型那句「用户选了哪个」必须是本轮的事实,
 * 退回「请稍后再问」这类占位会让 Agent 带着猜测继续往下做。等的位置就在这里 ——
 * 一个 Promise,由三条路了结:用户作答、本轮中止、提问失效(条目已被摘掉)。
 *
 * 单独成模块是因为它不碰 DB、不碰 electron:注册表与中止语义能脱离应用跑起来验证。
 */
export interface QuestionGate {
  /**
   * 登记一次提问并等它了结。
   * signal 中止时按「没拿到回答」(null)收场 —— 不能让它永远悬着,否则整个 run 的
   * 收尾、以及它占着的那个会话(切换工作空间与手动压缩都要求无进行中 run)一起卡死。
   */
  open: (questionId: string, signal: AbortSignal) => Promise<AskUserAnswer>
  /** 交回答案;这个 id 不在等待中(已回答过、已中止或压根不认识)时返回 false */
  answer: (questionId: string, answers: string[]) => boolean
  /** 还在等的提问数 */
  pending: () => number
}

export function createQuestionGate(): QuestionGate {
  // key 是提问 id,value 是「这次等待的了结方式」:同一 id 只能了结一次,靠 Map 的删除保证
  const waiting = new Map<string, (answer: AskUserAnswer) => void>()

  return {
    open: (questionId: string, signal: AbortSignal): Promise<AskUserAnswer> =>
      new Promise<AskUserAnswer>((resolve) => {
        // 中止可能先于提问发生(run 的最后一次工具调用与用户按下停止挤在一起)
        if (signal.aborted) {
          resolve(null)
          return
        }
        const settle = (answer: AskUserAnswer): void => {
          waiting.delete(questionId)
          signal.removeEventListener('abort', onAbort)
          resolve(answer)
        }
        const onAbort = (): void => settle(null)
        waiting.set(questionId, settle)
        signal.addEventListener('abort', onAbort, { once: true })
      }),

    answer: (questionId: string, answers: string[]): boolean => {
      const settle = waiting.get(questionId)
      if (!settle) return false
      settle(answers)
      return true
    },

    pending: (): number => waiting.size
  }
}
