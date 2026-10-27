import type { IpcMainInvokeEvent } from 'electron'
import { buildReport } from './service'
import type { IpcResult } from '../chat/dto'
import type { UsageStatsQuery, UsageStatsReport } from './dto'

/** 统一包装 handler 结果,异常转为 { success: false, msg } */
function run<T>(fn: () => T): IpcResult<T> {
  try {
    return { success: true, data: fn() }
  } catch (error) {
    return { success: false, msg: error instanceof Error ? error.message : String(error) }
  }
}

/** 一次区间的用量统计。纯读,不改任何状态 */
export function report(
  _e: IpcMainInvokeEvent,
  query: UsageStatsQuery
): IpcResult<UsageStatsReport> {
  return run(() => buildReport(query))
}
