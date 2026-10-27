import { ipcRenderer } from 'electron'
import type { IpcResult } from '../../main/chat/dto'
import type { UsageStatsQuery, UsageStatsReport } from '../../main/stats/dto'

export default {
  /**
   * 一段日期区间里的 token 用量统计(合计、按天、按模型)。
   * from / to 是本地日历日 'YYYY-MM-DD',含两端。
   */
  report: (query: UsageStatsQuery): Promise<IpcResult<UsageStatsReport>> =>
    ipcRenderer.invoke('stats:report', query)
}
