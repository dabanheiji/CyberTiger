/**
 * 外链的两个纯判定。主进程那一层要拦下所有「把应用窗口导航走」的点击,
 * 这两件事与 electron 无关,放在这里才能脱离窗口跑单测。
 */

/**
 * 允许交给系统默认浏览器的协议。
 *
 * 黑名单挡不住任意注册过的自定义协议(装过某个客户端就多出一个),所以用白名单:
 * `file:` / `javascript:` / `data:` 这类一旦漏出去,后果比「链接点不开」严重得多。
 */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/**
 * 把点到的链接归一成「该交给系统浏览器打开的那一条」;返回 null 表示不该外开。
 */
export function externalLinkFor(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.toString() : null
}

/** Windows 上盘符大小写不保证一致,路径比较因此按平台放宽;其余平台逐字节比 */
function samePath(a: URL, b: URL): boolean {
  return process.platform === 'win32'
    ? a.pathname.toLowerCase() === b.pathname.toLowerCase()
    : a.pathname === b.pathname
}

/**
 * 这个地址是不是应用自己那一份文档。
 *
 * `will-navigate` 只放它过去:页面刷新(错误页那颗「重新加载」)与开发时 HMR 的整页重载
 * 都落在同一个地址上。哈希路由与 query 不换文档,所以比较 origin + pathname 就够。
 */
export function isAppDocument(candidate: string, appDocument: string): boolean {
  let target: URL
  let app: URL
  try {
    target = new URL(candidate)
    app = new URL(appDocument)
  } catch {
    return false
  }
  return target.origin === app.origin && samePath(target, app)
}
