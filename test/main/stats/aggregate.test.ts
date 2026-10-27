import {
  aggregateUsage,
  localDayOf,
  localDaysInRange,
  utcBoundsForRange
} from '../../../src/main/stats/aggregate'
import type { UsageRow } from '../../../src/main/stats/sql'

/**
 * 日界断言必须钉住时区:同一条 UTC 时间在东八区与西五区落在不同的本地日,
 * 不固定 TZ 的话这个文件会跟着跑测试的机器变红。
 */
process.env.TZ = 'Asia/Shanghai'

function row(createdAt: string, overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    created_at: createdAt,
    provider_id: 'p-1',
    model: 'qwen3.5:4b',
    prompt_tokens: 100,
    completion_tokens: 20,
    tokens_estimated: 0,
    ...overrides
  }
}

describe('UTC 时间与本地日历日的换算', () => {
  it('库里 UTC 晚上十点的行归到本地第二天:报表按用户过的那一天算,不按字符串前 10 位', () => {
    expect(localDayOf('2026-10-08 15:59:59')).toBe('2026-10-08')
    expect(localDayOf('2026-10-08 16:00:00')).toBe('2026-10-09')
  })

  it('区间边界左闭右开:一头是本地零点,另一头是次日本地零点,整秒的写入不漏也不重', () => {
    expect(utcBoundsForRange('2026-10-08', '2026-10-08')).toEqual({
      start: '2026-10-07 16:00:00',
      end: '2026-10-08 16:00:00'
    })
  })

  it('筛区间用的边界与分桶用的日界是同一条换算:落进筛选结果的行必然落进序列里的某天', () => {
    const bounds = utcBoundsForRange('2026-10-06', '2026-10-08')
    const days = localDaysInRange('2026-10-06', '2026-10-08')
    // 区间内外的样本各给几个,含两端整点
    for (const createdAt of [
      '2026-10-05 15:59:59',
      '2026-10-05 16:00:00',
      '2026-10-07 03:00:00',
      '2026-10-08 15:59:59',
      '2026-10-08 16:00:00',
      '2026-10-09 08:00:00'
    ]) {
      const inBounds = createdAt >= bounds.start && createdAt < bounds.end
      expect(inBounds).toBe(days.includes(localDayOf(createdAt)))
    }
  })

  it('两端给反了读成同一段:一次点选的顺序不该让报表变成空白', () => {
    expect(localDaysInRange('2026-10-08', '2026-10-06')).toEqual(
      localDaysInRange('2026-10-06', '2026-10-08')
    )
    expect(utcBoundsForRange('2026-10-08', '2026-10-06')).toEqual(
      utcBoundsForRange('2026-10-06', '2026-10-08')
    )
  })

  it('跨月的序列按日历推进:月长不是 30 天,靠 Date 的日历加法而不是加 24 小时', () => {
    expect(localDaysInRange('2026-01-29', '2026-02-02')).toEqual([
      '2026-01-29',
      '2026-01-30',
      '2026-01-31',
      '2026-02-01',
      '2026-02-02'
    ])
  })

  it('跨夏令时那几天不是 24 小时,序列仍不漏日也不重日', () => {
    const saved = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try {
      // 2026-03-08 美国转入夏令时:那天只有 23 小时
      expect(localDaysInRange('2026-03-07', '2026-03-09')).toEqual([
        '2026-03-07',
        '2026-03-08',
        '2026-03-09'
      ])
    } finally {
      process.env.TZ = saved
    }
  })
})

describe('按天序列与合计', () => {
  it('没用过的那些天补零:序列长度恒等于区间天数,画柱状图不必担心缺柱', () => {
    const { daily, totals } = aggregateUsage(
      [row('2026-10-07 03:00:00')],
      '2026-10-06',
      '2026-10-08'
    )
    expect(daily).toEqual([
      { day: '2026-10-06', prompt: 0, completion: 0, steps: 0 },
      { day: '2026-10-07', prompt: 100, completion: 20, steps: 1 },
      { day: '2026-10-08', prompt: 0, completion: 0, steps: 0 }
    ])
    // 补零的两天不该被算进「活跃天数」
    expect(totals.activeDays).toBe(1)
  })

  it('同一天跨 UTC 中午的两步归到同一天:一天的账不会裂成两根柱', () => {
    const { daily } = aggregateUsage(
      [
        row('2026-10-08 01:00:00', { prompt_tokens: 10, completion_tokens: 1 }),
        row('2026-10-08 09:00:00', { prompt_tokens: 20, completion_tokens: 2 })
      ],
      '2026-10-08',
      '2026-10-08'
    )
    expect(daily).toEqual([{ day: '2026-10-08', prompt: 30, completion: 3, steps: 2 }])
  })

  it('合计、各天、各模型三份账同源:加起来是同一批数,界面不会出现两处对不上', () => {
    const { totals, daily, byModel } = aggregateUsage(
      [
        row('2026-10-06 02:00:00', { model: 'a' }),
        row('2026-10-07 02:00:00', { model: 'a', prompt_tokens: 7, completion_tokens: 3 }),
        row('2026-10-07 05:00:00', {
          model: 'b',
          provider_id: 'p-2',
          prompt_tokens: 50,
          completion_tokens: 5
        })
      ],
      '2026-10-06',
      '2026-10-08'
    )
    const sum = (items: Array<{ prompt: number; completion: number }>): number =>
      items.reduce((acc, item) => acc + item.prompt + item.completion, 0)
    expect(totals.total).toBe(120 + 10 + 55)
    expect(sum(daily)).toBe(totals.total)
    expect(sum(byModel)).toBe(totals.total)
    expect(byModel.reduce((acc, m) => acc + m.steps, 0)).toBe(totals.steps)
  })

  it('只有端点没报 usage 的那些步算进估算占比:估算的绝对值按整步计', () => {
    const { totals } = aggregateUsage(
      [
        row('2026-10-08 02:00:00', { prompt_tokens: 100, completion_tokens: 20 }),
        row('2026-10-08 03:00:00', {
          prompt_tokens: 300,
          completion_tokens: 100,
          tokens_estimated: 1
        })
      ],
      '2026-10-08',
      '2026-10-08'
    )
    expect(totals.total).toBe(520)
    expect(totals.estimatedTokens).toBe(400)
    expect(totals.estimatedRatio).toBeCloseTo(400 / 520, 10)
  })

  it('一条用量都没有时比例给 0 而不是 NaN:除零在界面会显示成「NaN%」', () => {
    const { totals, daily, byModel } = aggregateUsage([], '2026-10-06', '2026-10-08')
    expect(totals).toEqual({
      prompt: 0,
      completion: 0,
      total: 0,
      steps: 0,
      estimatedTokens: 0,
      estimatedRatio: 0,
      activeDays: 0
    })
    expect(daily).toHaveLength(3)
    expect(byModel).toEqual([])
  })
})

describe('按模型归集', () => {
  it('分组键是「服务商 + 模型名」:两个服务商的同名模型不合并成一个', () => {
    const { byModel } = aggregateUsage(
      [
        row('2026-10-08 02:00:00', { provider_id: 'p-1', model: 'qwen3.5:4b' }),
        row('2026-10-08 03:00:00', { provider_id: 'p-2', model: 'qwen3.5:4b' })
      ],
      '2026-10-08',
      '2026-10-08'
    )
    expect(byModel.map((m) => m.providerId)).toEqual(['p-1', 'p-2'])
  })

  it('加那两列之前的历史行归成一桶:空 provider_id + 空 model,界面叫它「未记录模型」', () => {
    const { byModel } = aggregateUsage(
      [
        row('2026-10-08 02:00:00', { provider_id: '', model: '' }),
        row('2026-10-08 03:00:00', { provider_id: '', model: '' })
      ],
      '2026-10-08',
      '2026-10-08'
    )
    expect(byModel).toHaveLength(1)
    expect(byModel[0]).toMatchObject({ providerId: '', model: '', steps: 2 })
  })

  it('排行按用量降序;用量相同的按模型名、再按服务商 id 排,同一份数据两次打开顺序一致', () => {
    const { byModel } = aggregateUsage(
      [
        row('2026-10-08 02:00:00', { model: 'zzz', prompt_tokens: 10, completion_tokens: 1 }),
        row('2026-10-08 02:00:00', { model: 'aaa', prompt_tokens: 10, completion_tokens: 1 }),
        row('2026-10-08 02:00:00', { model: 'big', prompt_tokens: 500, completion_tokens: 50 })
      ],
      '2026-10-08',
      '2026-10-08'
    )
    expect(byModel.map((m) => m.model)).toEqual(['big', 'aaa', 'zzz'])
  })

  it('share 是这个模型占总量的比例,整列加起来是 1:界面直接写成百分比', () => {
    const { byModel } = aggregateUsage(
      [
        row('2026-10-08 02:00:00', { model: 'half', prompt_tokens: 50, completion_tokens: 50 }),
        row('2026-10-08 03:00:00', {
          model: 'rest',
          prompt_tokens: 50,
          completion_tokens: 50,
          provider_id: 'p-2'
        })
      ],
      '2026-10-08',
      '2026-10-08'
    )
    expect(byModel.map((m) => m.share)).toEqual([0.5, 0.5])
  })
})
