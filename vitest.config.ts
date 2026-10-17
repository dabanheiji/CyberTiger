import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const stub = (name: string): string =>
  fileURLToPath(new URL(`./test/stubs/${name}`, import.meta.url))

export default defineConfig({
  /**
   * alias 用数组 + 精确正则:对象形式是前缀匹配,`electron` 会顺手吃掉 `electron-store`。
   * tsc 不读这里的 alias,类型检查仍按真实依赖走 —— 替身只在运行时生效,业务代码
   * 新增 Electron API 用法时需同步补 stub,由 boot.test.ts 兜住。
   * better-sqlite3 也必须换掉:它是原生模块,`postinstall` 后是 Electron ABI,
   * 在 Node 里 require 会因 NODE_MODULE_VERSION 不匹配直接失败。
   */
  resolve: {
    alias: [
      { find: /^electron$/, replacement: stub('electron.ts') },
      { find: /^electron-store$/, replacement: stub('electron-store.ts') },
      { find: /^better-sqlite3$/, replacement: stub('better-sqlite3.ts') }
    ]
  },
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      // 只统计已有测试的模块,避免未测页面把数字稀释到无意义
      include: [
        'src/main/shared/**',
        'src/main/skills/{parser,registry,tools,installer}.ts',
        'src/main/agents/{parser,registry,builtin}.ts',
        'src/main/database/{migrate,sql}.ts',
        'src/main/store/modelRef.ts',
        'src/main/appearance.ts',
        'src/main/sandbox/**',
        'src/main/agent/**',
        'src/main/chat/questions.ts',
        'src/main/tools/registry.ts',
        'src/main/tools/jail.ts',
        'src/renderer/src/lib/**'
      ],
      reporter: ['text', 'html']
    }
  }
})
