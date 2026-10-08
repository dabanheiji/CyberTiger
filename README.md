# CyberTiger

基于 Electron 的桌面 AI 助手：多会话聊天 + ReAct Agent（工具调用）+ Skills（`SKILL.md` 指令插件）+ MCP 工具接入 + 子 Agent 派生。模型走 OpenAI 兼容接口，服务商可配（兼容 DeepSeek / Ollama / vLLM 等）。

架构、目录与开发约定的完整说明见 [AGENTS.md](./AGENTS.md)。

## 已实现

- **多会话聊天**：SQLite 持久化，流式输出，思考过程（reasoning）展示，随时中止
- **ReAct Agent 循环**：推理 → 工具调用 → 观察，最多 10 步；每步落库并流式回推
- **多模型服务商**：各自独立的 `baseUrl` / `apiKey` / 模型清单，单次 run 显式绑定服务商
- **MCP 接入**：stdio 与 Streamable HTTP，实时合并远端工具，带连接状态推送
- **Skills**：`SKILL.md` 目录扫描、渐进式加载、`/` 手动触发、GitHub / URL / 本地安装
- **子 Agent**：`task` 工具派生独立上下文的子 run，自定义 `AGENT.md` 角色，过程内联展开

## Roadmap / TODO

按优先级排列。P0 是**已经在出错的路径**，不是锦上添花；P1 之后是增量能力。

### P0 · 上下文与 Token 管理

长会话目前必然崩：历史全量回放、无裁剪、无 token 计数，工具结果也不截断。

- [ ] 抽出独立的 `context/` 模块，收拢"哪些内容进上下文"的决策
- [ ] Token 估算（可先用字符数近似），支持按模型配置上下文窗口
- [ ] 历史裁剪策略：保 system + 最近 N 轮 + 滚动摘要
- [ ] 工具结果分级截断（统一在 loop / runner 层，而非只截子 Agent 结论）
- [ ] 开启 `stream_options.include_usage`，采集每步真实 token 用量
- [ ] 超限错误的可读化提示 + 自动裁剪后重试
- [ ] 会话滚动摘要压缩（长对话自动降级为摘要 + 近期窗口）

### P1 · 工具权限层 + 原生工具集

用户不配 MCP 时，目前只有 `get_current_time` 可用。补原生工具前**必须先有审批机制**。

- [ ] 工具危险等级标记（`dangerous`）+ 调用前确认弹窗
- [ ] 审批白名单持久化（按工具 / 按参数匹配）
- [ ] 文件读取 / 写入 / 列目录（限定工作区路径）
- [ ] HTTP 请求 / 网页抓取
- [ ] 剪贴板读写
- [ ] Shell 执行（**依赖审批层落地后**，需限定工作目录与超时）

### P2 · 对话基本盘

- [ ] 重新生成（regenerate）最后一条回复
- [ ] 编辑用户消息并重发
- [ ] 失败后重试单步，而非新建会话
- [ ] 消息分支 / 版本切换

### P3 · 可观测性

调 Agent 提示词需要抓手：现在有大量精细的提示词策略，却看不到实际效果。

- [ ] 每 run 记录 JSONL 日志：各步 token、耗时、工具调用序列
- [ ] 标记是否命中去重缓存、是否触发目标锚定
- [ ] 会话级用量 / 耗时 / 成本汇总面板
- [ ] 调试面板：查看本次 run 实际发送的完整请求消息

### P4 · 检索与导出

- [ ] SQLite FTS5 全文搜索（跨会话搜消息）
- [ ] 导出会话为 Markdown / JSON
- [ ] 会话归档 / 置顶 / 批量管理

### P5 · MCP 深化

受众较窄，排在原生工具之后。

- [ ] MCP resources / prompts 支持
- [ ] OAuth 认证
- [ ] 断线自动重连（指数退避）
- [ ] 工具名冲突检测与消解
- [ ] 连接失败的界面重试入口

### 工程基建（贯穿进行）

- [ ] 引入 vitest，优先覆盖纯逻辑：`toolKey` 去重、易变工具历史占位、`filterTools`、frontmatter 校验、`modelRef`、installer 串行队列
- [ ] 清理 lint 基线（当前约 12 个 error）
- [ ] CI（typecheck + lint + test）
- [ ] E2E 冒烟（Playwright 驱动 Electron）

### 零散待办

- [ ] 暴露模型采样参数 temperature / max_tokens / top_p（当前一个都不可配）
- [ ] 统一打包脚本：`build:mac` 缺少 `npm run typecheck`
- [ ] 设置页补 `githubToken` 配置项（目前只存在于类型定义，无 UI）
- [ ] 评估 `sandbox: false` 的必要性，尽量收紧渲染层沙箱

## Project Setup

### Install

```bash
npm install
```

`postinstall` 会通过 `electron-builder install-app-deps` 重建原生模块（`better-sqlite3`）。

### Development

```bash
npm run dev
```

### Quality Gates

```bash
npm run typecheck   # 双 tsconfig：main/preload + renderer
npm run lint        # 注意：基线非零，改动不应新增 error
npm run build       # typecheck + 三进程构建
```

### Build

```bash
npm run build:win     # Windows
npm run build:mac     # macOS
npm run build:linux   # Linux
```

### Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)
