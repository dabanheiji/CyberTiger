/**
 * matcher 的界面侧规则:一行一条的文本 ↔ matcher 数组。
 *
 * 命中判定住在主进程(`src/main/hooks/matcher.ts`),这里只管编辑。
 */

/**
 * matcher 条目的形状说明,外加它与审批名单那处分刻意的分歧。
 *
 * 唯一事实来源是 `src/main/hooks/matcher.ts` 的 `HOOK_MATCHER_SHAPES`(判定就按它执行),
 * 但那个文件把 `tools/risk.ts` 的命令切段带了进来,不该进渲染层的包,所以这里同值抄一份 ——
 * 与 `lib/permissionLists.ts` 同一条纪律。抄错了不会报错,只会让用户照着界面配出一条
 * 永远不生效(或生效范围超出预期)的条目,所以两份相等由 `test/renderer/lib/hookMatchers.test.ts` 钉住。
 */
export const HOOK_MATCHER_SHAPES: string[] = [
  '留空:该事件下的每一次调用都触发',
  '工具名:精确匹配该工具,如 write_file、github__create_issue',
  'server 前缀:以 __ 结尾,匹配该 MCP server 的全部工具,如 github__',
  '命令前缀:<工具名>:<命令前缀>,对 run_command 与 background_job 的 start 生效,按 token 边界匹配,如 run_command:git push',
  '与审批名单不同:命令前缀只要任一分段命中就触发,所以 `ls; git push` 也会被拦下'
]

/**
 * 一行一条的文本切成数组:按行拆、去首尾空白、丢空行。
 *
 * 不去重、不剪上限:主进程 `buildHookFile` 会原样收下,超过条目上限时**报错**而不是静默丢掉。
 * 这里剪掉的话,用户配的拦截钩子会因为他多贴了几行而变松,那比报错严重。
 */
export function parseHookEntries(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** 数组回到文本框里的样子(每行一条,末尾不加换行) */
export function joinHookEntries(entries: string[]): string {
  return entries.join('\n')
}
