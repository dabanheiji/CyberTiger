import os from 'node:os'
import path from 'node:path'

/**
 * 只在测试运行时替换 `electron`。每个用例可以通过 CYBERTIGER_TEST_HOME 指定根目录,
 * 默认落到系统临时目录下的固定位置,避免污染真实的 userData。
 */
const root =
  process.env.CYBERTIGER_TEST_HOME ?? path.join(os.tmpdir(), 'cybertiger-test', 'default')

const paths = new Map<string, string>()

export const listeners = new Map<string, Array<() => void>>()

export const app = {
  getPath(name: string): string {
    const cached = paths.get(name)
    if (cached) return cached
    // temp 直接用给定名(macOS 下真实 Electron 给的是 per-user 临时目录,语义一致即可)
    const dir = path.join(root, name)
    paths.set(name, dir)
    return dir
  },
  getName(): string {
    return 'cybertiger-test'
  },
  /**
   * database/index.ts 在模块顶层注册 before-quit 来关库。这里只登记不响应,
   * 需要时由测试自己触发。
   */
  on(event: string, handler: () => void): void {
    listeners.set(event, [...(listeners.get(event) ?? []), handler])
  }
}

export const net = {
  fetch: (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    globalThis.fetch(input, init)
}

/**
 * `themeSource` 是可写的,所以 `applyThemeSource` 的映射能直接被断言。
 * `shouldUseDarkColors` 保持常量:替身没有真正的系统外观,测「手动模式落到哪」就够了。
 */
export const nativeTheme = {
  themeSource: 'system',
  shouldUseDarkColors: false,
  on(event: string, handler: () => void): void {
    listeners.set(event, [...(listeners.get(event) ?? []), handler])
  }
}

export default { app, net, nativeTheme }
