import type { ApprovalOutcome, ApprovalSettlement, PendingApprovalDto } from './dto'

/**
 * 等待用户批准的审批请求。
 *
 * 与 `questions.ts` 的提问通道同构:Agent 阻塞在一次工具调用上,「批没批」必须是本轮的事实,
 * 退回「请稍后再执行」这类占位会让模型带着猜测往下做。等的位置就在这里 —— 一个 Promise,
 * 由四条路了结:用户按下按钮、本轮中止、无人应答超时、id 已不在等待中。
 *
 * 单独成模块是因为它不碰 DB、不碰 electron:注册表、中止与超时语义能脱离应用跑起来验证。
 * 与提问通道的两点差异:
 * - **有超时**。提问等的是「用户此刻正在做的选择」,审批却可能撞上窗口关了、渲染层崩了,
 *   那种情况不能让 run 永久悬着 —— 一个 run 占着会话,切换工作空间与手动压缩都进不去。
 * - **载荷留着可读**。渲染层 Cmd+R 之后事件全丢,要靠 `list()` 把还挂着的卡片填回来。
 */

/**
 * 审批等待的上限。
 * 取 3 分钟:够一个人读完卡片、看清那条命令行再决定,又短到「没人在看屏幕」时不会把整轮吊住。
 * 超时按未批准收场 —— 宁可模型重新发起一次、用户再批一遍。
 */
export const APPROVAL_TIMEOUT_MS = 180_000

export interface ApprovalGate {
  /** 登记一次审批请求并等它了结;中止与超时都给出结论,不会永远悬着 */
  open: (request: PendingApprovalDto, signal: AbortSignal) => Promise<ApprovalSettlement>
  /** 交回决定;这个 id 不在等待中(已决定过、已了结或压根不认识)时返回 false */
  decide: (approvalId: string, outcome: ApprovalOutcome, reason?: string) => boolean
  /** 还在等的请求:渲染层重载后据此补回卡片 */
  list: () => PendingApprovalDto[]
}

interface Waiting {
  request: PendingApprovalDto
  settle: (settlement: ApprovalSettlement) => void
}

/**
 * 造一个审批通道。
 *
 * `timeoutMs` 是给单测留的参数(生产一律用默认值):等 3 分钟的分支没法在测试里跑。
 */
export function createApprovalGate(timeoutMs: number = APPROVAL_TIMEOUT_MS): ApprovalGate {
  // key 是 approvalId,value 是「这次等待的了结方式」加上展示载荷
  // 同一 id 只了结一次,靠 Map 的删除保证:先摘条目再 resolve,迟到第二次决定返回 false
  const waiting = new Map<string, Waiting>()

  return {
    open: (request: PendingApprovalDto, signal: AbortSignal): Promise<ApprovalSettlement> =>
      new Promise<ApprovalSettlement>((resolve) => {
        const { approvalId } = request
        // 中止可能先于登记发生(run 的最后一次工具调用与用户按下停止挤在一起)
        if (signal.aborted) {
          resolve({ kind: 'aborted' })
          return
        }
        // 三条了结路共用同一个收尾:定时器与监听器都要摘掉,否则超时后中止还会再 resolve 一次
        const finish = (settlement: ApprovalSettlement): void => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          waiting.delete(approvalId)
          resolve(settlement)
        }
        const onAbort = (): void => finish({ kind: 'aborted' })
        const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs)
        waiting.set(approvalId, { request, settle: finish })
        signal.addEventListener('abort', onAbort, { once: true })
      }),

    decide: (approvalId: string, outcome: ApprovalOutcome, reason?: string): boolean => {
      const entry = waiting.get(approvalId)
      if (!entry) return false
      entry.settle(
        outcome === 'deny'
          ? { kind: 'deny', reason: (reason ?? '').trim() }
          : { kind: outcome === 'allow_run' ? 'allow_run' : 'allow' }
      )
      return true
    },

    list: (): PendingApprovalDto[] => [...waiting.values()].map((entry) => entry.request)
  }
}
