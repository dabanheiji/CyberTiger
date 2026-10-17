import fs from 'fs'
import { describeFsError } from './tools/paths'
import type { SandboxSettings } from './store/types'

/**
 * 一次 run 的文件写入 jail:根目录**一定是 realpath 过的**,判定层因此不再兜根那一侧。
 *
 * 为什么单独一个叶子模块:调用点在 `chat/service.ts` 的 `startRun`,而它已经牵着
 * DB 与 electron-store;这一层只吃两份纯值(设置里那一键 + 会话的工作空间),
 * 「jail 开不开」这条规则就能脱离应用被单测钉住。
 *
 * 为什么缺省是**开**:与 `permissions` 缺键即 `'ask'` 同一条纪律 —— 老用户的配置文件里
 * 没有这一键,而 jail 正是更严的那一侧。
 */
export function jailFor(
  sandbox: SandboxSettings | undefined,
  workspace: string
): { root: string } | undefined {
  if (sandbox?.enabled === false) return undefined
  const dir = workspace.trim()
  // 没选工作空间就无处可 jail:那一支仍走「越界写入一律审批」的老路
  if (!dir) return undefined
  try {
    fs.mkdirSync(dir, { recursive: true })
    return { root: fs.realpathSync(dir) }
  } catch (error) {
    // fail-closed:建不出来就整轮不开始,而不是静默退回"没有边界"继续跑
    throw new Error(`工作空间目录 ${dir} 已不可用:${describeFsError(error)},写入未执行`)
  }
}
