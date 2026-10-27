import { describe, expect, it } from 'vitest'
import {
  QUICK_RANGES,
  axisDayLabel,
  labelStep,
  matchingQuickRange,
  modelDisplayName,
  percentText,
  providerSuffix,
  quickRange,
  type QuickRange
} from '../../../src/renderer/src/lib/reportRange'

/**
 * 日期全部用本地字段构造(new Date(y, m, d)),不用 ISO 串:
 * ISO 串按 UTC 解析,同一份用例在东八区和 UTC 机器上会落在不同的日历日上,
 * 而这里要钉的恰恰是「本地那一天」。
 */
function localDay(year: number, month1: number, day: number): Date {
  return new Date(year, month1 - 1, day)
}

describe('quickRange', () => {
  it('「最近 N 天」含今天:七天区间是今天往前数六天,首尾都算', () => {
    expect(quickRange('last7', localDay(2026, 10, 18))).toEqual({
      from: '2026-10-12',
      to: '2026-10-18'
    })
  })

  it('跨过年初和月末也是按日历退:减天数不是减毫秒', () => {
    // 若写成 now - 6*86400000,在有过夏令时的时区里会出现「退七天只跨六个日历日」
    expect(quickRange('last7', localDay(2026, 1, 3)).from).toBe('2025-12-28')
    expect(quickRange('last30', localDay(2026, 3, 15)).from).toBe('2026-02-14')
    expect(quickRange('lastYear', localDay(2026, 10, 18))).toEqual({
      from: '2025-10-19',
      to: '2026-10-18'
    })
  })

  it('认不出的取值退回七天而不是抛错:默认区间是字符串进来的,不能让它空白一片', () => {
    const now = localDay(2026, 10, 18)
    expect(quickRange('notARange' as QuickRange, now)).toEqual(quickRange('last7', now))
  })
})

describe('matchingQuickRange', () => {
  it('区间正好等于某个快捷区间时认得出来:按钮组该亮哪一颗', () => {
    const now = localDay(2026, 10, 18)
    for (const item of QUICK_RANGES) {
      expect(matchingQuickRange(quickRange(item.value, now), now)).toBe(item.value)
    }
  })

  it('用户自己框的区间不硬凑成最近的预设:那排按钮要全部不选中', () => {
    const now = localDay(2026, 10, 18)
    // 与「最近 7 天」只差一天(整体往前挪),不能被判成 last7
    expect(matchingQuickRange({ from: '2026-10-11', to: '2026-10-17' }, now)).toBeUndefined()
    // 跨过所有预设的天数
    expect(matchingQuickRange({ from: '2026-09-01', to: '2026-10-18' }, now)).toBeUndefined()
  })

  it('过了午夜还按新的今天判:昨天框的七天不会被认成「最近 7 天」', () => {
    const yesterday = localDay(2026, 10, 17)
    const range = quickRange('last7', yesterday)
    expect(matchingQuickRange(range, localDay(2026, 10, 18))).toBeUndefined()
  })
})

describe('坐标轴标签', () => {
  it('轴上只写月-日:完整日期在 hover 那行给,横轴不重复', () => {
    expect(axisDayLabel('2026-10-18')).toBe('10-18')
  })

  it('横轴最多八个标签:点数一多就隔几个标一次', () => {
    // 八天以内天天标 —— 这时候压不住的不是标签而是柱子
    expect(labelStep(1)).toBe(1)
    expect(labelStep(7)).toBe(1)
    expect(labelStep(8)).toBe(1)
    // 九个点起开始跳着标,且步长向上取整保证标签数不超过八
    expect(labelStep(9)).toBe(2)
    expect(labelStep(30)).toBe(4)
    expect(labelStep(90)).toBe(12)
    expect(labelStep(365)).toBe(46)
    for (const count of [9, 13, 31, 91, 366]) {
      expect(Math.ceil(count / labelStep(count))).toBeLessThanOrEqual(8)
    }
  })

  it('步长至少为一:空区间不能算出 0 让取模炸开', () => {
    expect(labelStep(0)).toBe(1)
  })
})

describe('percentText', () => {
  it('整数百分比四舍五入:估算占比与模型占比都走这一个形状', () => {
    expect(percentText(0)).toBe('0%')
    expect(percentText(0.5)).toBe('50%')
    expect(percentText(0.256)).toBe('26%')
  })

  it('不到 1% 的保留一位小数:一律取整会把「用了一点」显示成 0%,读起来像没用过', () => {
    expect(percentText(0.008)).toBe('0.8%')
    expect(percentText(0.001)).toBe('0.1%')
    // 恰好 1% 及以上回到整数
    expect(percentText(0.01)).toBe('1%')
  })
})

describe('模型名与服务商的显示形状', () => {
  it('空模型名归进「未记录模型」:加那两列之前的历史行照样算进总量,但界面不假装知道是谁跑的', () => {
    expect(modelDisplayName('')).toBe('未记录模型')
    expect(modelDisplayName('qwen3.5:4b')).toBe('qwen3.5:4b')
  })

  it('服务商名为空就整段不写,不留一个空括号', () => {
    expect(providerSuffix('')).toBe('')
    expect(providerSuffix('本地 Ollama')).toBe(' · 本地 Ollama')
  })
})
