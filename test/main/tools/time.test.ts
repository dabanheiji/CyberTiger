import { getCurrentTimeTool } from '../../../src/main/tools/time'

const ctx = { callId: 'call-1' }

/** 跑一次并解析返回的 JSON 文本 */
function run(args: Record<string, unknown>): Record<string, string> {
  const out = getCurrentTimeTool.execute(args, ctx)
  if (out instanceof Promise) throw new Error('时间工具应当同步返回')
  return JSON.parse(out) as Record<string, string>
}

describe('get_current_time 的描述文案', () => {
  it('不含「必须重新调用」这类祈使:描述每步都随请求下发,会把一轮变成三步', () => {
    // 实测:用户问"我在郑州,告诉我今天几点了",旧描述结尾那句让模型连着三步重调本工具。
    // 跨轮必须重取本就由 volatile + 历史占位符在结构上保证,描述再喊一遍只会把范围
    // 从"每一轮"扩到"每一步"。
    expect(getCurrentTimeTool.description).not.toMatch(/必须重新调用|请重新调用|每次.*调用/)
  })

  it('给出「中国境内统一使用北京时间」这个事实,模型就不必按城市名猜时区', () => {
    // 模型找不到 Asia/Zhengzhou 时不会承认拿不到,而是依次试 Chongqing、Changchun。
    // 用事实收敛比用指令有效:它当时正在做的本来就是"挑一个更贴切的城市名"。
    expect(getCurrentTimeTool.description).toContain('中国境内统一使用北京时间')
  })
})

describe('get_current_time 执行', () => {
  it('省略 timezone 时用系统时区', () => {
    expect(run({}).timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })

  it('同偏移的不同城市名给出相同的 utc_offset', () => {
    // 换城市名换不回不同的时间,这正是重复调用毫无收益的地方
    const shanghai = run({ timezone: 'Asia/Shanghai' })
    const chongqing = run({ timezone: 'Asia/Chongqing' })
    expect(chongqing.utc_offset).toBe(shanghai.utc_offset)
  })

  it('非法时区抛错并说明要用 IANA 时区名', () => {
    expect(() => run({ timezone: 'Asia/Zhengzhou' })).toThrow(/IANA 时区名/)
  })
})
