type Values = Record<string, unknown>

/**
 * 运行时替换 `electron-store`。src/main/store/index.ts 在模块顶层就 new 了实例,
 * 所以必须在 alias 层替换,per-file vi.mock 抢不到那么早。
 * 只实现项目实际用到的面(flat key),不支持点路径。
 */
export default class StubStore {
  private values: Values

  constructor(options: { defaults?: Values } = {}) {
    this.values = { ...options.defaults }
  }

  get(key: string): unknown {
    return this.values[key]
  }

  set(key: string, value: unknown): void {
    this.values[key] = value
  }

  delete(key: string): void {
    delete this.values[key]
  }

  clear(): void {
    this.values = {}
  }
}
