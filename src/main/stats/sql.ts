/** 一行 assistant 的用量列;字段名与 SQL 列名一致,`aggregate.ts` 直接吃这个形状 */
export interface UsageRow {
  created_at: string
  provider_id: string
  model: string
  prompt_tokens: number
  completion_tokens: number
  tokens_estimated: number
}

export const statsSql = {
  /**
   * 取区间内所有 assistant 行的用量。
   *
   * 这里**只筛区间、只取列**,不做任何日期函数:SQLite 的 `date()` / `strftime()` 按 UTC 算,
   * 而报表要的是用户本地那一天的账 —— 两套日界写在一起是最容易出错的样子,所以日界换算
   * 全在 `aggregate.ts`,那一边能被单测逐条钉住。
   *
   * 边界是左闭右开,两个值都由 `utcBoundsForRange` 从本地日历日换算而来,
   * 于是「一天」在筛选和分桶两处必然是同一段。
   *
   * 子 Agent 的行也在这里(`role='assistant'`,只是 `depth` 与 `parent_call_id` 不同):
   * 它同样烧 token,把它排除掉的话总量就对不上用户账单上的量级了。
   */
  usageInRange: `SELECT created_at, provider_id, model, prompt_tokens, completion_tokens, tokens_estimated
    FROM messages
    WHERE role = 'assistant' AND created_at >= ? AND created_at < ?
    ORDER BY created_at ASC, rowid ASC`
}
