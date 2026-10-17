import fs from 'fs'
import path from 'path'

/**
 * 文件路径 jail:把「写到哪儿」这件事从模型的自由发挥变成边界内的事实。
 *
 * 与 `paths.ts` 的 `anchor()` 是**两套判定,不可互抄**:`anchor` 只做纯文本比较,
 * 判错的代价是多写一行标注;这里判错的代价是逃出边界、把机器上的文件改了,
 * 所以必须走 `fs.realpath`。mac 上 `/tmp → /private/tmp`、`/etc → /private/etc`
 * 都是软链,不解真身就会把界内的路径判成界外(或反过来),而两种都静默。
 */

/** 只有「这一节确实还不存在」才允许往前退着问;其余错误原样抛出 */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** 根末尾的分隔符不算路径的一部分;根本身(`/` 或 `C:\`)剥掉后就剩下空串 */
function withoutTrailingSep(dir: string): string {
  if (dir.endsWith(path.sep)) return dir.slice(0, -path.sep.length)
  return dir.endsWith('/') ? dir.slice(0, -1) : dir
}

/**
 * 把一条路径解到它在真实文件系统上的位置,**返回的就是该拿去做 fs 操作的那条**。
 *
 * 两步,顺序不能换:
 * 1. 先在字形上折掉 `..`(`path.normalize`)。这一步必须自己做:实测 macOS(libuv 自带
 *    一份 realpath)按字形折 `..`,而 glibc 会先跟完软链再折 —— 同一句 `ws/link/../x`
 *    两边结论不同。判定跨平台不一致,比判定严一点或松一点更难排查。
 * 2. 再退到第一个存在的祖先解软链,尾巴上那些还不存在的段按字形接在真身之后。
 *    不能只 realpath 不退:新建文件必然 `ENOENT`,一报错就放弃判定,等于没有 jail。
 *    也不能只折 `..` 不 realpath:软链指向根外时字形看着在根内,解出真身才看得见。
 *
 * 返回路径因此**不含 `..`**:前缀已解成真身,尾巴是还没落地的段 —— 调用方拿它去
 * open,内核走的就是判定过的这条,不存在「判完字形再 open 原路径」那种白判。
 * 中段是一个已存在的普通文件时不报越界:ENOTDIR 交给 fs 去说准确。
 */
export function resolveDeep(abs: string): string {
  const tail: string[] = []
  let current = path.normalize(abs)
  for (;;) {
    try {
      const real = fs.realpathSync(current)
      return tail.length === 0 ? real : path.resolve(real, ...tail.reverse())
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    const parent = path.dirname(current)
    if (parent === current) {
      // 退到顶还存在过又解不开,是 fs 本身的问题,不在这里编一个越界结论
      throw new Error(`无法确定 ${abs} 的真实位置:${abs} 所在的目录读不出来`)
    }
    tail.push(path.basename(current))
    current = parent
  }
}

export interface Confined {
  /** 解出来的真身路径:调用方要拿它去 stat / mkdir / open */
  real: string
  /** false = 落在根外 */
  inside: boolean
}

/**
 * 判定一条写入目标在不在根内。`realRoot` **必须已经是 realpath 的结果** ——
 * 解根这件事由接线那一层(`main/sandbox.ts` 的 `jailFor`)负责一次,判层不再兜,
 * 否则每条写入都要多解一次根,而漏解的那次就是静默的错判。
 */
export function confinement(target: string, realRoot: string): Confined {
  const real = resolveDeep(target)
  const base = withoutTrailingSep(realRoot)
  // 空根即没有 jail:由调用方决定退回标注模式,判层不反过来把一切都拒掉
  if (base === '') return { real, inside: true }
  // 相等或严格多出一整段才算界内:`/ws-project` 不是 `/ws` 的子目录。
  // win 上大小写不一致会判成界外(多拒一次,方向是安全的),真实盘符由 realpath 给
  return { real, inside: real === base || real.startsWith(base + path.sep) }
}

/**
 * 越界即抛一句陈述句。
 *
 * 抛错而不是返回 `{ok:false}`:`registry.ts` 的 `executeTool` 已经把抛错转成给模型的
 * 失败说明,工具因此不可能留一条没有对应 tool 行的 `tool_calls`。措辞不写祈使,
 * 模型会把「请改用工作空间内的路径」当成本轮待办去执行。
 */
export function confine(target: string, realRoot: string): string {
  const { real, inside } = confinement(target, realRoot)
  if (!inside) {
    throw new Error(`${target} 的写入落在本次会话的工作空间 ${realRoot} 之外,本次写入未执行`)
  }
  return real
}
