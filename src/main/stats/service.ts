import { getDb } from '../database/index'
import { listProviders } from '../store/providers'
import { aggregateUsage, utcBoundsForRange } from './aggregate'
import { statsSql, type UsageRow } from './sql'
import type { UsageStatsQuery, UsageStatsReport } from './dto'

/**
 * 服务商 id → 界面上显示的名字。
 *
 * 报表读的是历史行里记下的 id,而那个 id 可能指向一个已经被删掉的服务商。这时退回显示 id
 * 并写明它被删了,而不是把用量凭空抹掉:那些 token 是真花出去的,只是现在认不出主人。
 * provider_id 为空串的那些行是「加这两列之前」的历史数据,它们不给名字 ——
 * 界面上那一桶叫「未记录模型」。
 */
function namesById(): Map<string, string> {
  const names = new Map<string, string>()
  for (const provider of listProviders()) names.set(provider.id, provider.name)
  return names
}

/**
 * 一次报表查询:筛区间交给 SQL,分日与按模型归集交给纯的 `aggregate.ts`。
 *
 * 口径两处要留意:上下文压缩那几次调用的用量记在 `conversations.summary_usage`,
 * 没有逐日也没有模型归属,所以不进这里;子 Agent 的步骤进这里(它同样烧 token)。
 */
export function buildReport(query: UsageStatsQuery): UsageStatsReport {
  const { start, end } = utcBoundsForRange(query.from, query.to)
  const rows = getDb().prepare<[string, string], UsageRow>(statsSql.usageInRange).all(start, end)
  const report = aggregateUsage(rows, query.from, query.to)
  const names = namesById()
  for (const item of report.byModel) {
    if (item.providerId.length === 0) continue
    item.providerName = names.get(item.providerId) ?? `${item.providerId}(服务商已删除)`
  }
  return report
}
