import type { AskUserSettlement, PendingQuestionDto } from './dto'

/**
 * 等待用户回答的提问。
 *
 * `ask_user` 工具会把问题发给渲染层然后**等**着:模型那句「用户选了哪个」必须是本轮的事实,
 * 退回「请稍后再问」这类占位会让 Agent 带着猜测继续往下做。等的位置就在这里 ——
 * 一个 Promise,由四条路了结:用户作答、本轮中止、无人应答超时、id 已不在等待中。
 *
 * 单独成模块是因为它不碰 DB、不碰 electron:注册表、中止与超时语义能脱离应用跑起来验证。
 * 与审批通道(`approvals.ts`)同构,多出来的那两条差异也是同一个理由:
 * - **有超时**。提问等的是「用户此刻正在做的选择」,但窗口可能被关掉、渲染层可能崩掉,
 *   那种情况不能让 run 永久悬着 —— 一个 run 占着会话,切换工作空间与手动压缩都进不去。
 * - **载荷留着可读**。渲染层 Cmd+R 之后事件全丢,要靠 `list()` 把还挂着的卡片填回来。
 *   没有这一条,主进程仍阻塞在那次调用上,而界面上再也没有地方能回答它。
 */

/**
 * 提问等待的上限。
 * 取 10 分钟:提问往往是用户离开座位去查一件事,比审批(3 分钟)给得宽;
 * 但再长就只是把一个忘掉的会话吊在「有进行中 run」上了。
 */
export const QUESTION_TIMEOUT_MS = 600_000

export interface QuestionGate {
  /** 登记一次提问并等它了结;中止与超时都给出结论,不会永远悬着 */
  open: (
    questionId: string,
    request: PendingQuestionDto,
    signal: AbortSignal
  ) => Promise<AskUserSettlement>
  /** 交回答案;这个 id 不在等待中(已回答过、已了结或压根不认识)时返回 false */
  answer: (questionId: string, answers: string[]) => boolean
  /** 还在等的提问:渲染层重载后据此补回卡片 */
  list: () => PendingQuestionDto[]
  /** 还在等的提问数 */
  pending: () => number
}

interface Waiting {
  request: PendingQuestionDto
  settle: (settlement: AskUserSettlement) => void
}

/**
 * 造一个提问通道。
 *
 * `timeoutMs` 是给单测留的参数(生产一律用默认值):等 10 分钟的分支没法在测试里跑。
 */
export function createQuestionGate(timeoutMs: number = QUESTION_TIMEOUT_MS): QuestionGate {
  // key 是 questionId,value 是「这次等待的了结方式」加上展示载荷
  // 同一 id 只了结一次,靠 Map 的删除保证:先摘条目再 resolve,迟到第二次作答返回 false
  const waiting = new Map<string, Waiting>()

  return {
    open: (
      questionId: string,
      request: PendingQuestionDto,
      signal: AbortSignal
    ): Promise<AskUserSettlement> =>
      new Promise<AskUserSettlement>((resolve) => {
        // 中止可能先于提问发生(run 的最后一次工具调用与用户按下停止挤在一起)
        if (signal.aborted) {
          resolve({ kind: 'aborted' })
          return
        }
        // 三条了结路共用同一个收尾:定时器与监听器都要摘掉,否则超时后中止还会再 resolve 一次
        const finish = (settlement: AskUserSettlement): void => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          waiting.delete(questionId)
          resolve(settlement)
        }
        const onAbort = (): void => finish({ kind: 'aborted' })
        const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs)
        waiting.set(questionId, { request, settle: finish })
        signal.addEventListener('abort', onAbort, { once: true })
      }),

    answer: (questionId: string, answers: string[]): boolean => {
      const entry = waiting.get(questionId)
      if (!entry) return false
      entry.settle({ kind: 'answered', answers })
      return true
    },

    list: (): PendingQuestionDto[] => [...waiting.values()].map((entry) => entry.request),

    pending: (): number => waiting.size
  }
}
