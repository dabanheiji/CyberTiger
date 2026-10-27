/**
 * 报表页的纯函数:区间怎么算、坐标轴标签怎么挑、数字与模型名怎么写。
 *
 * 这一层不起进程也不碰 electron,所以日界与格式化的规则都能脱离应用断言。
 * 日期一律是本地日历日字符串('YYYY-MM-DD'),与 `stats/dto.ts` 里查询的两端同一种形状;
 * 把 UTC 换算成本地那一天归主进程(`stats/aggregate.ts`)做,这里只管人看得见的那个串。
 */

/** 一个含首含尾的本地日历日区间 */
export interface DayRange {
  from: string
  to: string
}

/** '2026-10-08' 这样的日期串:走 Date 的本地字段而不是自己拼,月长交给它 */
function toDay(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 往前 n 天的那一天。用 setDate 而不是减 86400000:跨夏令时的头一天不是 24 小时 */
function shiftDays(date: Date, daysBack: number): Date {
  const shifted = new Date(date)
  shifted.setDate(shifted.getDate() - daysBack)
  return shifted
}

/**
 * 快捷区间:「最近 N 天」含今天,所以往前取 N-1 天。
 *
 * 默认落在最近七天,与页面标题同一条口径。给到近一年而不给「全部」:
 * 按天画的趋势图,横轴是连续日历,区间拉到几年就会画出上千根柱子,
 * 那不是统计图而是噪点 —— 真要看得很远的用户可以用日期选择器自己框。
 */
export const QUICK_RANGES = [
  { value: 'last7', label: '最近 7 天', days: 7 },
  { value: 'last30', label: '最近 30 天', days: 30 },
  { value: 'last90', label: '最近 90 天', days: 90 },
  { value: 'lastYear', label: '近一年', days: 365 }
] as const

export type QuickRange = (typeof QUICK_RANGES)[number]['value']

export function quickRange(value: QuickRange, now = new Date()): DayRange {
  const days = QUICK_RANGES.find((item) => item.value === value)?.days ?? 7
  return { from: toDay(shiftDays(now, days - 1)), to: toDay(now) }
}

/** 这个区间是不是恰好等于某个快捷区间:自定义过日期之后,那排按钮该全部不选中 */
export function matchingQuickRange(range: DayRange, now = new Date()): QuickRange | undefined {
  return QUICK_RANGES.find((item) => {
    const preset = quickRange(item.value, now)
    return preset.from === range.from && preset.to === range.to
  })?.value
}

/**
 * 横轴上的日期标签:只写月-日。
 *
 * 完整日期在 hover 的那行数字里给,轴上不重复 —— 一年区间的轴如果每条都写全,
 * 标签会互相压住,而读者要的只是「大概哪一段」。
 */
export function axisDayLabel(day: string): string {
  return day.slice(5)
}

/**
 * 每隔几个点标一次日期,横轴上最多八个标签。
 *
 * 柱宽跟着点数走,但标签不会:七天标七次没问题,九十次就糊成一团了。
 */
export function labelStep(count: number): number {
  return count <= 8 ? 1 : Math.ceil(count / 8)
}

/**
 * 比例写成百分比。
 *
 * 不到 1% 的保留一位小数:报表里「某个模型占比」和「估算占比」都常年是个小数字,
 * 一律四舍五入就成了「0%」,而 0% 读起来像「一次都没用」。
 */
export function percentText(ratio: number): string {
  const percent = ratio * 100
  if (percent > 0 && percent < 1) return `${percent.toFixed(1)}%`
  return `${Math.round(percent)}%`
}

/**
 * 模型名的显示形状。
 *
 * 空串是「加模型归属那两列之前的历史行」,归成一桶叫「未记录模型」——
 * 它们照样花掉了 token,所以算进总量,但界面不能假装知道是谁跑的。
 */
export function modelDisplayName(model: string): string {
  return model.length === 0 ? '未记录模型' : model
}

/**
 * 模型那一行后面的服务商说明。
 *
 * 历史行的 provider_id 是空串(那时没记),已删除的服务商由主进程退回成「<id>(服务商已删除)」,
 * 两种都没有可显示的名字 —— 空串就整段不写,而不是写一个空括号。
 */
export function providerSuffix(providerName: string): string {
  return providerName.length === 0 ? '' : ` · ${providerName}`
}
