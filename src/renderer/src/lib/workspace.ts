/** 底栏显示用的短标签:取末段目录名,和 codex / IDE 的标题栏一个读法 */
export function workspaceLabel(dir: string): string {
  const value = dir.trim()
  if (!value) return '未选择工作空间'
  // 去掉尾部分隔符再取末段;整串就是根目录时(去掉后为空)保留原串,不然标签会空白
  const trimmed = value.replace(/[\\/]+$/, '') || value
  const segments = trimmed.split(/[\\/]+/)
  return segments[segments.length - 1] || trimmed
}

/**
 * 把目录挪到「最近使用」最前:已存在的同一路径先摘掉,不重复占位。
 * 空串不进清单 —— 清除工作空间不该往历史里塞一条空记录。
 */
export function pushRecent(list: string[], dir: string, limit = 5): string[] {
  const value = dir.trim()
  if (!value) return list
  const rest = list.filter((item) => item.trim() && item !== value)
  return [value, ...rest].slice(0, limit)
}

/**
 * 未选工作空间的会话所在的分组键。
 * 不能直接用空串:`Conversations` 把空 `group` 当作「这条不分组」,那样这些会话会散落在
 * 各组之间且没有标题,也就没有组标题上那颗「+」。
 */
export const NO_WORKSPACE_GROUP = '__no_workspace__'

/** 会话的分组键:工作空间目录本身,未选择时用一个非空的哨兵值 */
export function workspaceGroupKey(dir: string): string {
  return dir.trim() || NO_WORKSPACE_GROUP
}

/** 分组键回到目录,空串即「这一组的会话没有工作空间」 */
export function workspaceGroupDir(key: string): string {
  return key === NO_WORKSPACE_GROUP ? '' : key
}
