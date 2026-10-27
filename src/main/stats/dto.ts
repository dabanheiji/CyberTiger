/**
 * 报表的跨进程契约:渲染层只问「哪一段日期」,主进程只答「这段日期里模型烧了多少 token」。
 *
 * 这里不放任何计算规则 —— 日界换算与分组都在 `aggregate.ts`,那层能脱离 electron 跑单测。
 */

/**
 * 一次报表查询。
 *
 * from / to 都是**用户的本地日历日**('YYYY-MM-DD'),含两端。用日历日而不是时间戳:
 * 库里的 `created_at` 是 UTC 文本,把它换算成本地哪一天这件事只该有一个实现(在 aggregate.ts),
 * 渲染层跟着 antd 的日期选择器给字符串最简单,也给不出第二个时区。
 */
export interface UsageStatsQuery {
  from: string
  to: string
}

/** 区间合计。六个数字就是报表顶部那六张卡 */
export interface UsageTotals {
  /** 输入 token 总和(含本地估算的那部分) */
  prompt: number
  /** 输出 token 总和 */
  completion: number
  /** prompt + completion */
  total: number
  /** 模型调用次数:一行 assistant 即一步,子 Agent 的步骤也算 */
  steps: number
  /** 其中来自本地估算(端点没上报 usage)的 token 数 */
  estimatedTokens: number
  /** estimatedTokens / total,total 为 0 时是 0。这一档越高,上面的数越只能当量级看 */
  estimatedRatio: number
  /** 区间内有用量的日历天数。用来区分「一直在用」和「集中烧了一天」 */
  activeDays: number
}

/** 按天趋势里的一个点。缺天由聚合层补零,所以这个数组是连续日历序列 */
export interface DailyUsage {
  /** 本地日历日 'YYYY-MM-DD' */
  day: string
  prompt: number
  completion: number
  steps: number
}

/**
 * 按模型汇总的一条。
 *
 * 分组键是「服务商 + 模型名」而不是只有模型名:两个服务商可以有同名模型,而它们的用量
 * 属于两套配置。`model` 为空串表示这一行写下时还没记录模型归属(报表加那两列之前的历史数据),
 * 界面把它显示成「未记录模型」。
 */
export interface ModelUsage {
  providerId: string
  /** 服务商显示名;服务商已被删掉时是「<id>(服务商已删除)」,历史行为空串 */
  providerName: string
  model: string
  prompt: number
  completion: number
  total: number
  steps: number
  estimatedTokens: number
  /** 该模型占总量的比例 0..1 */
  share: number
}

/**
 * 一次查询的结果。
 *
 * 口径要说清两件事:只统计对话里的模型调用(上下文压缩那几次调用的用量记在
 * `conversations.summary_usage`,既没有逐日也没有可靠的模型归属,所以不进这里);
 * 包含子 Agent 的步骤。
 */
export interface UsageStatsReport {
  totals: UsageTotals
  daily: DailyUsage[]
  byModel: ModelUsage[]
}
