import type { DailyUsage, ModelUsage, UsageTotals } from './dto'
import type { UsageRow } from './sql'

/**
 * 报表的聚合核心:把「库里那些 UTC 文本时间 + 逐行 token 数」换成界面要的三件事 ——
 * 区间合计、连续的按天序列、按模型排行。
 *
 * 这一层是纯的:不认识 DB、不认识 electron、也不认服务商显示名(那是 service 的事)。
 * 日界换算集中在这里只有一份,因为 `created_at` 是 UTC 文本而报表按用户的本地日历日分桶,
 * 两边各写一半迟早会漂出「图上这一天和筛出来这天不是同一天」那种错。
 */

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`
}

/** 'YYYY-MM-DD' → 该本地日零点的毫秒 */
function localMidnight(day: string): number {
  return new Date(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7)) - 1,
    Number(day.slice(8, 10))
  ).getTime()
}

/** 毫秒 → 本地日历日 'YYYY-MM-DD' */
function toLocalDay(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 毫秒 → UTC 文本,与 SQLite 的 CURRENT_TIMESTAMP 同形状,所以能按字典序比较 */
function toUtcText(ms: number): string {
  const date = new Date(ms)
  return (
    `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ` +
    `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`
  )
}

/** 本地日历日加减 n 天。走 Date 的日历加法而不是加 24 小时:夏令时那两天不是 24 小时 */
function addLocalDays(day: string, n: number): string {
  const date = new Date(localMidnight(day))
  date.setDate(date.getDate() + n)
  return toLocalDay(date.getTime())
}

export interface UtcBounds {
  start: string
  end: string
}

/**
 * 两端排个先后。
 *
 * 日期选择器给不出倒序区间,但这条链的另一端是 IPC:顺序给反了也应当读成同一段,
 * 而不是让报表显示成「这段时间一次都没用过」。筛区间与列日历在这里用同一份归一,
 * 两边不会因排序不同而给出两套答案。
 */
function ordered(from: string, to: string): [string, string] {
  return to < from ? [to, from] : [from, to]
}

/**
 * 本地日历日区间(含两端)→ `created_at` 上的两个 UTC 文本边界,左闭右开。
 *
 * 右端取「to 的次日零点」而不是 `to 23:59:59`,否则最后那一秒整的写入会被漏掉。
 */
export function utcBoundsForRange(from: string, to: string): UtcBounds {
  const [first, last] = ordered(from, to)
  return {
    start: toUtcText(localMidnight(first)),
    end: toUtcText(localMidnight(addLocalDays(last, 1)))
  }
}

/**
 * 库里的 `created_at`(UTC 文本)落在本地哪一天。
 *
 * 跨时区一定会挪日子:UTC 晚上十点写下的行,在东八区已经是第二天。
 * 报表按用户的一天算,所以这里跟着本机时区换算,而不是把那个字符串前 10 位当日期用。
 */
export function localDayOf(createdAt: string): string {
  return toLocalDay(
    Date.UTC(
      Number(createdAt.slice(0, 4)),
      Number(createdAt.slice(5, 7)) - 1,
      Number(createdAt.slice(8, 10)),
      Number(createdAt.slice(11, 13)),
      Number(createdAt.slice(14, 16)),
      Number(createdAt.slice(17, 19))
    )
  )
}

/**
 * 区间内的每一天,升序,含两端。
 *
 * 跨度用「日历日的毫秒差除以一天」再四舍五入:跨夏令时的头一天可能是 23 或 25 小时,
 * 取整比截断稳,而 `addLocalDays` 走的是 Date 的日历加法,所以序列本身不会漏日也不会重日。
 */
export function localDaysInRange(from: string, to: string): string[] {
  const [first, last] = ordered(from, to)
  const span = Math.round((localMidnight(last) - localMidnight(first)) / 86_400_000)
  const days: string[] = []
  for (let i = 0; i <= span; i++) days.push(addLocalDays(first, i))
  return days
}

export interface AggregateResult {
  totals: UsageTotals
  daily: DailyUsage[]
  byModel: ModelUsage[]
}

/** 分组键:服务商 id 与模型名。分隔符用 NUL,因为模型名里不会出现它 */
function modelKey(providerId: string, model: string): string {
  return `${providerId}\u0000${model}`
}

/**
 * 把区间内的 assistant 行聚成报表要的三份数据。
 *
 * 三份都从同一个 rows 循环算出来,所以「合计 = 各天之和 = 各模型之和」是结构上的事实,
 * 不需要额外的一致性检查。补零也在这里(SHOW 之前先按天建好连续序列),界面拿到的
 * `daily` 长度恒等于区间天数,画柱状图不必担心缺柱。
 */
export function aggregateUsage(rows: UsageRow[], from: string, to: string): AggregateResult {
  const daily = new Map<string, DailyUsage>()
  for (const day of localDaysInRange(from, to)) {
    daily.set(day, { day, prompt: 0, completion: 0, steps: 0 })
  }
  const byModel = new Map<string, ModelUsage>()

  let prompt = 0
  let completion = 0
  let estimatedTokens = 0

  for (const row of rows) {
    const stepTotal = row.prompt_tokens + row.completion_tokens
    prompt += row.prompt_tokens
    completion += row.completion_tokens
    // 端点没报 usage 的那一步,两个数都是本地估的;估算的绝对值按整步算
    if (row.tokens_estimated === 1) estimatedTokens += stepTotal

    const day = daily.get(localDayOf(row.created_at))
    if (day) {
      day.prompt += row.prompt_tokens
      day.completion += row.completion_tokens
      day.steps += 1
    }

    const key = modelKey(row.provider_id, row.model)
    let model = byModel.get(key)
    if (!model) {
      model = {
        providerId: row.provider_id,
        providerName: '',
        model: row.model,
        prompt: 0,
        completion: 0,
        total: 0,
        steps: 0,
        estimatedTokens: 0,
        share: 0
      }
      byModel.set(key, model)
    }
    model.prompt += row.prompt_tokens
    model.completion += row.completion_tokens
    model.total += stepTotal
    model.steps += 1
    if (row.tokens_estimated === 1) model.estimatedTokens += stepTotal
  }

  const total = prompt + completion
  let activeDays = 0
  for (const item of daily.values()) if (item.steps > 0) activeDays += 1

  // 排行按用量降序;同量时按模型名升序,否则同一份数据两次打开的顺序会跟着 Map 插入序漂
  const models = [...byModel.values()].sort(
    (a, b) =>
      b.total - a.total ||
      a.model.localeCompare(b.model) ||
      a.providerId.localeCompare(b.providerId)
  )
  for (const item of models) item.share = total === 0 ? 0 : item.total / total

  return {
    totals: {
      prompt,
      completion,
      total,
      steps: rows.length,
      estimatedTokens,
      estimatedRatio: total === 0 ? 0 : estimatedTokens / total,
      activeDays
    },
    daily: [...daily.values()],
    byModel: models
  }
}
