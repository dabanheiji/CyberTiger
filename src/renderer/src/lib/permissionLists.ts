/**
 * 黑白名单的界面侧规则:一行一条的文本 ↔ 名单数组。
 *
 * 判定住在主进程(`src/main/tools/permission.ts`),这里只管编辑。
 */

/** 名单条目上限:再多过这条线,用户已经不会回头读自己配了什么 */
export const MAX_LIST_ENTRIES = 100

/**
 * 三种条目形状的说明。
 *
 * 唯一事实来源是 `src/main/tools/permission.ts` 的 `LIST_ENTRY_SHAPES`(判定就按它执行),
 * 但那个文件依赖 node:path,进不了渲染层的构建范围,所以这里同值抄一份。
 * 两边同值由 `test/renderer/lib/permissionLists.test.ts` 钉住 —— 抄错了不会报错,
 * 只会让用户照着界面配出一个不生效的条目,那比没说明更糟。
 */
export const LIST_ENTRY_SHAPES: string[] = [
  '命令前缀:只对 run_command 生效,按 token 边界匹配,且整条命令每个分段都要命中,如 npm run build',
  '工具名:该工具整体免审或必审,如 write_file、github__create_issue',
  'server 前缀:以 __ 结尾,匹配该 MCP server 的全部工具,如 github__'
]

/**
 * 把文本框里的内容切成名单:按行切、去首尾空白、去空行、去重,最后截到上限。
 *
 * 顺序保留用户写的顺序(黑名单里同一条命令的不同写法要能各自读到),去重留第一次出现的那条。
 */
export function parsePermissionList(text: string): string[] {
  const seen = new Set<string>()
  const list: string[] = []
  for (const line of text.split('\n')) {
    const entry = line.trim()
    if (!entry || seen.has(entry)) continue
    seen.add(entry)
    list.push(entry)
    if (list.length >= MAX_LIST_ENTRIES) break
  }
  return list
}
