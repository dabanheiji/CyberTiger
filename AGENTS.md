# Repository Guidelines

CyberTiger —— 基于 Electron 的桌面 AI 助手：多会话聊天 + ReAct Agent（工具调用）+ Skills（`SKILL.md` 指令插件）+ MCP（stdio / Streamable HTTP）工具接入。模型走 OpenAI 兼容接口（`baseUrl` 可配，兼容 Ollama / DeepSeek 等）。

## Architecture & Data Flow

三进程 Electron 应用，主进程严格分层：**renderer → preload router → `ipcMain.handle` → controller（IPC 适配）→ service（业务 + DB）→ 纯逻辑模块**。

- **IPC 请求链**：渲染层只经 `window.api`（preload router）调用；`src/main/ipc/index.ts` 集中注册全部 handler，频道命名统一 `域:动作`（`chat:*` / `skills:*` / `mcp:*` / `settings:*`）。
- **一次 Agent run**：`chat:generateReply` 同步返回 `runId` → 后台 `runAgent`（`src/main/agent/loop.ts`，ReAct，`MAX_STEPS = 10`）循环「推理 → 工具调用 → 观察」→ 每步落库并经 `chat:stream` 事件流式回推渲染层 → `chat:abortReply` / 退出时 `abortAll()` 中止。
- **工具注入**：`getAllTools()` = 内置工具 + 已连接 MCP 工具（实时合并）。Skills 走两条独立路径——① 渐进式加载：system prompt 里放启用 skill 的 name/description 目录，模型按需调 `load_skill`；② `/` 手动触发：skill 名写入 `messages.skill`，`buildHistory` 展开成 `[Skill: xxx]` + 正文。
- **持久化**：对话数据在 SQLite（`cybertiger.db`，better-sqlite3）；应用配置在 electron-store（`config.json`）。状态单向推送：`fs.watch`（skills）、MCP 事件、流式事件。

## Key Directories

| 路径 | 用途 |
|---|---|
| `src/main/chat/` | 聊天核心：`service.ts`（会话/消息 + run 管理）、`controller.ts`（IPC 适配）、`llm.ts`（流式调用 + 多供应商 reasoning 归一）、`dto.ts`（**跨进程契约源**）、`sql.ts`（全部 SQL 常量 + 行类型） |
| `src/main/agent/` | `loop.ts`（ReAct 循环 + `AgentStore` 接口）、`history.ts`（请求消息组装 / skill 展开 / volatile 结果替换）、`prompt.ts`（中文 system prompt） |
| `src/main/tools/` | `registry.ts`（注册 / 查找 / 执行）、`types.ts`（`ToolDefinition`）、`time.ts`（内置工具示例） |
| `src/main/skills/` | `registry.ts`（目录扫描 / 读取）、`parser.ts`（frontmatter 校验）、`installer.ts`（GitHub/URL/本地安装）、`tools.ts`（`load_skill` / `read_skill_file`）、`controller.ts`（IPC） |
| `src/main/mcp/` | `manager.ts`（连接生命周期）、`config.ts`（zod 校验）、`controller.ts`（IPC） |
| `src/main/database/` | `index.ts`（初始化 + 迁移执行）、`sql.ts`（DDL + 迁移定义） |
| `src/main/store/` | electron-store 实例与 `AppSettings` 类型 |
| `src/main/window-state.ts` | 窗口大小/位置的持久化与启动还原（读写 `AppSettings.windowState`，含多显示器校验与最大化标记） |
| `src/main/ipc/index.ts` | 全部 IPC handler 注册入口 |
| `src/preload/router/` | 按域拆分的 invoke 封装 + 事件订阅（`onStream` / `onChange` / `onStatus`） |
| `src/renderer/src/pages/` | `chat/`（`index.tsx` 状态中枢、`ChatPanel.tsx` 输入与气泡、`Sidebar.tsx`）、`settings/`（模型 / MCP / Skills） |
| `src/renderer/src/hooks/` | `useAgentStream`（订阅 `chat:stream`）、`useSkills`、`useSystemTheme` |
| `src/renderer/src/components/` | `ToolCallChain`、`ReasoningBox` |

## Development Commands

```bash
npm install                 # postinstall 会重建原生模块 (electron-builder install-app-deps)
npm run dev                 # 开发启动（electron-vite dev，HMR）
npm run build               # typecheck(node+web) + electron-vite build → out/
npm run build:mac           # 打包 macOS（build:win / build:linux 同理）
npm run typecheck           # tsc --noEmit 跑 tsconfig.node.json + tsconfig.web.json
npm run lint                # ESLint 9 flat config
npm run format              # Prettier 全仓格式化
npm run start               # electron-vite preview（跑构建产物）
```

调试用 `.vscode/launch.json`：`Debug Main Process`（electron-vite）与 `Debug Renderer`（Chrome attach `127.0.0.1:9222`）可组合成 `Debug All`。主进程调试端口由 `REMOTE_DEBUGGING_PORT=9222` 控制。

## Code Conventions & Common Patterns

- **语言**：注释、提示词、用户可见错误信息均为中文；注释用 TSDoc `/** */`，解释「为什么」而非复述代码。
- **格式**（Prettier / EditorConfig 强制）：单引号、无分号、`printWidth 100`、无尾逗号、2 空格缩进、LF、文件末尾换行。
- **ESLint 硬约束**（`@electron-toolkit/eslint-config-ts`）：所有函数必须显式返回类型（`explicit-function-return-type: error`，含箭头函数与 React 组件 → `React.JSX.Element`）；禁止 `any`；`@ts-ignore` 必须附说明。
- **IPC 契约**：handler 返回 `IpcResult<T> = { success: true; data: T } | { success: false; msg: string }`，用统一包装器捕获异常（`chat/controller.ts` 的 `run()`、`skills/controller.ts` 的 `run()` / `runAsync()`）。**例外**：`settings:*` 直接返回原始值，无 `IpcResult`。
- **SQL 集中**：所有语句写在对应 `sql.ts` 里导出为常量（如 `chatSql.messages.list`），不在业务代码内联拼接。SCHEMA 变更必须走 `src/main/database/sql.ts` 的 `columnMigrations`（加列）或 `tableRebuilds`（改约束）——`CREATE TABLE IF NOT EXISTS` 对已有库不生效。
- **依赖注入**：纯逻辑模块不直接依赖 DB。`agent/loop.ts` 通过 `AgentStore` 接口接收落库操作，实现由 `chat/service.ts` 注入。
- **流式事件**：主进程 → 渲染层的事件统一用判别联合类型 `ChatStreamEvent`（`step_start` / `delta` / `tool_call` / `tool_result` / `done` / `error`），定义在 `chat/dto.ts`；渲染层按 `type` 分支消费。
- **错误处理**：工具执行 `executeTool` **永不抛错**，失败返回 `{ ok: false, result: 说明 }` 交给模型自纠；LLM 错误经 `toReadableMessage` 归一为面向用户的中文提示；skill 已被删/禁用时退化为普通消息，不中断对话。
- **异步模式**：串行化写操作（如 `skills/installer.ts` 的 `serialized` 队列）、防抖重扫（`skills/registry.ts` `scheduleRescan` 300ms）、资源清理用 `finally`。
- **前端状态**：无全局状态库。页面级 `useState` + `useRef`（ref 用于异步回调读取最新值，避免闭包过期）；跨组件复用逻辑放 `hooks/`；组件库统一用 antd 6 / `@ant-design/x`。
- **前端样式覆盖**：antd v6 样式包在 `:where(...)` 中（优先级 0），普通类选择器即可覆盖，**无需 `!important`**；需要选中间层 DOM 时用组件库的 `classNames.*` 语义槽（如 `Suggestion` 的 `classNames.popup` → 弹层根），再在 `assets/main.css` 写后代选择器。先例见 `.cybertiger-skill-dropdown`。
- **跨进程共享类型**：渲染层直接 import 主进程的纯类型文件，但**必须同步登记进 `tsconfig.web.json` 的 `include`**（目前 5 个文件：`chat/sql.ts`、`chat/dto.ts`、`mcp/types.ts`、`skills/types.ts`、`store/types.ts`）。新增共享类型文件若漏登记，web 侧类型检查会失败。

## Important Files

- `src/main/index.ts` —— 主进程入口（注册 IPC、初始化 MCP/Skills、窗口、退出清理）
- `src/main/ipc/index.ts` —— 全部 IPC handler 注册
- `src/main/chat/dto.ts` —— 跨进程数据契约（DTO / 事件 / `IpcResult`）
- `src/main/agent/loop.ts` —— Agent 主循环与 `AgentStore` 接口
- `src/main/tools/registry.ts` —— 工具注册与执行入口（新增内置工具在此挂载）
- `src/main/skills/parser.ts` —— `SKILL.md` 规范校验（`name` 必须 kebab-case 且等于目录名）
- `src/main/database/sql.ts` —— 建表 DDL 与迁移定义
- `src/preload/index.ts` + `src/preload/router/` —— `window.api` 暴露面
- `src/renderer/src/pages/chat/{index,ChatPanel}.tsx` —— 聊天页主体
- `electron.vite.config.ts` —— 三进程构建配置（唯一别名 `@renderer` → `src/renderer/src`）
- `tsconfig.node.json` / `tsconfig.web.json` —— 两套类型检查范围
- `eslint.config.mjs` / `.prettierrc.yaml` —— 质量与格式门禁
- `electron-builder.yml` —— 打包配置（`asarUnpack: resources/**`）

## Runtime / Tooling Preferences

- **运行时**：Node + Electron 39（内置 Node 22）；`@types/node` 为 v22。无 `engines` 字段，无 Bun/Deno 依赖。
- **包管理器**：**npm**（仓库有 `package-lock.json`；不要引入 pnpm/yarn lock 文件）。
- **镜像**：`.npmrc` 与 `electron-builder.yml` 均指向 npmmirror；新增依赖若走 npm 会沿用该镜像。
- **原生模块**：`better-sqlite3` 等原生依赖由 `postinstall` 的 `electron-builder install-app-deps` 重建；`electron-builder.yml` 设 `npmRebuild: false` 避免二次重建。
- **打包 externals**：`main` / `preload` 的 `dependencies` 被 electron-vite 自动 externalize（产物中是 `require("better-sqlite3")` 这类裸模块），**不能把 Node 原生依赖打进 bundle**。主进程在运行时读取 `../../resources/icon.png`，故 `resources/` 必须与 `out/` 同级且被 `asarUnpack`。
- **CSP**：`src/renderer/index.html` 固定 `default-src 'self'`，不要引入远端 CDN 资源。

## Testing & QA

**本项目没有任何测试框架、测试文件、CI 配置或 git hook**（无 vitest/jest/playwright，无 `test` 脚本）。验证依赖以下本地门禁：

1. `npm run typecheck` —— 双 tsconfig 覆盖 main/preload 与 renderer（提交前必过）
2. `npm run lint` —— 注意：**当前基线非零**（约 13 errors，集中在历史文件的 `no-explicit-any` / 显式返回类型 / `:where` 无关的既有问题）。改动不应新增 error。
3. `npm run build` —— `typecheck` + 三进程构建的完整串联
4. `npm run dev` 实测 —— 涉及 UI / 主进程行为的改动，启动应用实际走一遍相关路径（弹窗、输入、IPC、工具调用）

需要验证渲染层交互且无法人工观察时，可用 CDP 驱动真实窗口：以 `--remote-debugging-port=9222` 启动 Electron，通过 `/json` 拿页面 target 后用 WebSocket 执行 `Runtime.evaluate` / `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent`。注意 `npx electron .`（加载项目 `package.json` → `app.name=cybertiger`）才对应用正确的 userData；直接 `npx electron out/main/index.js` 会让 `app.name` 变成 `Electron`，读到空的 store 与 skills 目录。相同 URL 的 `Page.navigate` 不会重载页面，验证前应重启实例以获得干净状态。
