import type { ToolDefinition } from './types'

/** 校验 IANA 时区名;非法时 Intl 会抛 RangeError */
function isValidTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export const getCurrentTimeTool: ToolDefinition = {
  name: 'get_current_time',
  description:
    '获取当前的日期和时间。当用户询问现在几点、今天几号、星期几,或需要基于当前时间计算时调用。可指定 IANA 时区名(如 Asia/Shanghai、America/New_York),不指定则使用用户所在系统的时区。结果只代表调用那一刻,每次被问到时间都必须重新调用。',
  volatile: true,
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA 时区名,例如 Asia/Tokyo。省略则使用系统时区。'
      }
    },
    required: []
  },
  execute: (args) => {
    const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const tzArg = typeof args.timezone === 'string' ? args.timezone.trim() : ''
    const timeZone = tzArg || systemTz
    if (!isValidTimeZone(timeZone)) {
      throw new Error(`时区 "${timeZone}" 不合法,请使用 IANA 时区名,例如 Asia/Shanghai`)
    }

    const now = new Date()
    const formatted = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(now)
    const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone, weekday: 'long' }).format(now)
    const offset =
      new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
        .formatToParts(now)
        .find((p) => p.type === 'timeZoneName')?.value ?? ''

    return JSON.stringify({
      timezone: timeZone,
      utc_offset: offset,
      iso: now.toISOString(),
      local: formatted,
      weekday
    })
  }
}
