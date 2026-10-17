# CyberTiger

基于 Electron 的桌面 AI 助手：多会话聊天 + ReAct Agent（工具调用）+ Skills（`SKILL.md` 指令插件）+ MCP 工具接入 + 子 Agent 派生 + 上下文预算与压缩 + 三档工具审批、文件写入边界与 shell 的 OS 级受限执行。模型走 OpenAI 兼容接口，服务商可配（兼容 DeepSeek / Ollama / vLLM 等），界面与提示词均为中文。

架构、目录与开发约定的完整说明见 [AGENTS.md](./AGENTS.md)。

## 已实现

### 对话与 Agent

- **多会话聊天**：SQLite 持久化，流式输出，思考过程（reasoning）独立折叠框，随时中止且不留下残缺的工具调用
- **ReAct Agent 循环**：推理 → 工具调用 → 观察，最多 10 步；每步落库并经 `chat:stream` 事件流式回推
- **过程可视化**：工具链以思维链呈现（参数 / 结果可展开），正文一开始就自动收成「已调用 N 个工具」一行，把版面让给回答
- **同轮去重与目标锚定**：同一 run 内同名同参的工具只真正执行一次（命中的那次标注「已复用本轮结果」）；第 2 步起把当前请求重新贴到消息末尾，避免多步之后跑偏
- **向用户提问（`ask_user`）**：模型在几个都合理的分叉之间请用户拍板，候选项显示在输入框上方的卡片里，最后一项是自由输入，也可以跳过；run 阻塞在这次作答上，中止能干净收场
- **子 Agent**：`task` 工具派生**独立上下文**的子 run，角色来自 `agents/*/AGENT.md`（可增删改、可启停）；工具集按角色裁剪且剔除 `task`，结构上不可能递归；子过程内联展开在对应工具调用下

### 上下文管理

- **逐模型的上下文窗口**：窗口是模型配置的一部分（`ModelConfig.contextWindow`，缺省 131072），换服务商 / 换模型自动跟着变，子 Agent 用自己那个角色的模型算窗口
- **预算与三级裁剪**（`agent/context.ts`）：请求发出前压进预算，代价从小到大依次是整轮丢弃最旧历史 → 缩写超长消息 → 弃掉最近一轮里较早的连续步骤；分组单位是「轮」和「单元」，所以结构上不会造出孤儿 `tool_calls`
- **摘要 + 水位压缩**（`agent/compact.ts`）：把水位之后的老对话摘要成一段，形状是「system + 摘要块 + 近期原文」，前缀稳定可吃提示缓存；三个时机共用同一套逻辑——请求前自动、run 中途（带本轮执行状态便签，压完续跑不会把做过的工具再调一遍）、输入框旁边的手动压缩按钮（配上下文占用环）
- **真实用量优先**：端点上报的 `chunk.usage` 优先，不支持时自动降级并退回本地估算且标明「估算」；每步用量与这次裁剪丢了什么都会显示

### 工具与接入

- **原生工具集**：`get_current_time`、`load_skill` / `read_skill_file`、`read_file` / `write_file`、`run_command`、`task`、`ask_user`。文件与 shell 工具锚在**会话工作空间**上（相对路径与 `run_command` 的缺省 cwd 都以此为基准）
- **工程护栏**：命令超时默认 30s（上限 600s）、stdout/stderr 各留末尾 16k 字符、二进制与 >2MB 文件拒绝、中止时杀掉整个进程组、工具执行永不抛错（失败返回给模型自纠）
- **三档权限模式（审批）**：`ask` 面内全问 / `auto` 只放过证明得了只读的命令 / `full` 面内免审批（黑名单除外）。判定表在 `tools/permission.ts`、只读证明在 `tools/risk.ts`、等待在 `chat/approvals.ts`，执行由 `withApproval` 装饰 ToolRunner 拦住，主 / 子 Agent 走同一道闸门；黑白名单在设置页「权限」栏编辑
- **文件写入边界（jail）**：选了工作空间的会话里，`write_file` **写不到该目录之外**（绝对路径、`~`、`..`、工作空间内指向外面的软链都会被拒），判定走 `fs.realpath` 而不是文本比较。设置页「沙箱」栏可关闭；`full` 档 + 空名单那条今天也拦不住的路径由它兜住
- **shell 的受限执行**：同一条边界扩到 `run_command`——macOS 用 `/usr/bin/sandbox-exec` 加生成的 Seatbelt profile，Linux 用 `bwrap`，命令由内核包住：写入只在工作空间与临时目录里，`~/.ssh` / `~/.aws` / `~/.gnupg` / `~/.netrc` / `~/.config/gh` / 钥匙串目录点名读不到，环境变量走一份白名单（`SSH_AUTH_SOCK` 不在内）。启动器装在 `spawn` 的 argv 里而不是命令串里，所以审批的放行键逐字节不变；设置页「沙箱」栏有「受限执行」与「网络」两颗独立开关，Windows 没有对应机制、明写「这台机器上 shell 始终不受边界约束」
- **工作空间**：每个会话绑定一个目录，底栏可随时选择或清除，最近使用可复用；侧栏会话列表按工作空间分组，未选择工作空间的那批单独成组
- **Skills**：`SKILL.md` 目录扫描 + frontmatter 校验、渐进式加载（system 里只放目录，模型按需 `load_skill`）、`/` 手动触发、从 GitHub / URL / 本地安装，支持更新与卸载
- **MCP**：stdio 与 Streamable HTTP 两种传输，配置经 zod 校验，远端工具实时合并进工具池并带连接状态推送
- **多模型服务商**：`providers` 各自一套 `baseUrl` / `apiKey` / 模型清单；一次 run 显式绑定服务商，正在跑的那轮不受切换影响；候选清单不是白名单

## 已知边界

- **边界只管「写」，不管「读」**：`write_file` 与 `run_command` 的文件写入都被收在工作空间与临时目录里，但 `read_file` 仍能读根外文件，命令里的读取也只点名了几个凭据目录。读侧收敛（由符号链接 / 硬链接 / `/dev` / `/proc` 构成的最小可执行系统）是另一期
- **两平台的硬度不一样**：Linux 的 `bwrap --ro-bind / /` 是真·整盘只读，被点名的目录在命令里看着像不存在；macOS 那一份是 `allow default` + 点名 deny，读得到除了清单之外的一切，被挡下时报 `Operation not permitted`。两者都不是白名单式沙箱
- **凭据清单是人工维护的，注定列不全**：`.env` 故意不在 OS 清单里（工作空间里的 `.env` 是日常要读的），mac 的钥匙串走 `securityd` 那个服务、只 deny 文件路径挡不住 `security find-generic-password`；`read_file` 那一侧仍然只有提示词层面的措辞（system prompt 第 7 条 + 三份工具描述），模型可能不听
- **Windows 上没有对应机制**：AppContainer 要 native 码、Windows Sandbox 是起一台 VM，所以那一台的 `run_command` 一直不受这道边界约束，设置页按预检结论常驻说明这一点
- **引擎装不上时只拒 `run_command`**：不整轮报错，也绝不静默退回不受限地跑；设置页写明这条后果
- **审批不是沙箱**：它决定「问不问」，一次误点允许，命令就带着用户的全部权限真跑出去了。有了受限执行之后，后果从「改了整台机器」退成「改了授权范围内的东西」，而「这台机器上跑的就是模型写的代码」没有变
- **未选工作空间的会话没有边界**：没有根就没有 jail，也没有受限执行（两者同一个前提）；那种会话今天每条越界写都会弹审批（刻意的保守方向），关掉「沙箱」开关同样回到这条路
- **MCP 工具完全不在这层覆盖里**：它既不走 `write_file` 也不走 `run_command`，stdio server 的受限启动要单独建模（跨 run 存活、只能现读设置）
- MCP 工具的结果长度没有统一上限（内置工具各自有上限）
- 采样参数（temperature / max_tokens / top_p）不可配；`githubToken` 只存在于类型定义与安装器里，设置页没有入口
- 窗口重载会丢掉正在等待作答的提问，那一轮要直到点停止才收场
- ESLint 基线非零（12 errors / 25 warnings，集中在历史文件的 `no-explicit-any` 与显式返回类型）
- React 组件与 IPC 接线层没有自动化测试（单测是纯 node 环境，无 jsdom），靠 `npm run dev` 实测

## Roadmap / TODO

按优先级排列。P0 是**已经在出错的路径**（模型自行决定的写入与 shell），不是锦上添花——写侧那一半现在由内核收着，仍敞着的是读侧、Windows 与 MCP。

### P0 · 工具审批 + 硬沙箱

- [x] 三档权限模式（`ask` / `auto` / `full`）+ 执行前审批卡片 + 黑白名单（面内为 `run_command` 全部、越出工作空间的读写、MCP 工具）
- [x] 文件写入边界：`tools/jail.ts` 用 `fs.realpath` 把 `write_file` 收进工作空间，软链与 `..` 都算过真身；根不可用时 fail-closed
- [x] `run_command` 的受限执行：macOS 生成 Seatbelt profile 交给 `/usr/bin/sandbox-exec`，Linux 用 `bwrap`，启动器装在 argv 里（所以审批的放行键不变）；Windows 无对应机制，设置页明写「这台机器上 shell 仍不受限」；引擎装不上时直接拒绝该工具而不是退回不受限地跑
- [ ] 读侧收敛：`read_file` 与 shell 的读取要限制在由符号链接 / 硬链接 / `/dev` / `/proc` 构成的最小可执行系统内——只做路径检查注定漏，受限执行已经把「整盘可写」收成「两个目录可写」，这一条是它的另一半
- [ ] `deny` 名单的路径粒度（现在只能按命令前缀 / 工具名匹配；写侧已由 jail 消解，读侧仍是缺口）
- [ ] MCP stdio server 也走受限启动（它跨 run 存活、只能现读设置，与工具那一层的 run 快照是两条路，要分开建模）
- [ ] 统一在 loop / runner 层的工具结果上限（含 MCP 工具）

### P1 · 对话基本盘

- [ ] 重新生成（regenerate）最后一条回复
- [ ] 编辑用户消息并重发
- [ ] 失败后重试单步，而非新建会话
- [ ] 消息分支 / 版本切换

### P2 · 可观测性

调 Agent 提示词需要抓手：现在有大量精细的提示词与裁剪策略，却看不到实际效果。

- [ ] 每 run 记录 JSONL 日志：各步 token、耗时、工具调用序列
- [ ] 标记是否命中去重缓存、是否触发目标锚定、压缩发生在第几步
- [ ] 调试面板：查看本次 run 实际发送的完整请求消息
- [ ] 会话级用量 / 耗时 / 成本汇总

### P3 · 检索与导出

- [ ] SQLite FTS5 全文搜索（跨会话搜消息）
- [ ] 导出会话为 Markdown / JSON
- [ ] 会话归档 / 置顶 / 批量管理

### P4 · MCP 深化

受众较窄，排在原生工具与审批层之后。

- [ ] MCP resources / prompts 支持
- [ ] OAuth 认证
- [ ] 断线自动重连（指数退避）
- [ ] 工具名冲突检测与消解
- [ ] 连接失败的界面重试入口

### P5 · 补齐配置面

- [ ] 暴露模型采样参数 temperature / max_tokens / top_p
- [ ] 设置页补 `githubToken` 配置项
- [ ] 评估 `sandbox: false` 的必要性，尽量收紧**渲染进程沙箱**（Electron 的 `webPreferences.sandbox`，关的是界面能碰多少 Node；与上面 P0 的**工具执行沙箱**是两件事，后者关的是模型能写到哪儿）

### 工程基建（贯穿进行）

- [ ] CI（typecheck + lint + test）
- [ ] 清理 lint 基线（当前 12 error）
- [ ] E2E 冒烟（Playwright 驱动 Electron），补上组件与 IPC 接线层的空白
- [ ] 统一打包脚本：`build:mac` / `build:linux` 缺 `npm run typecheck`（`build:win` 有）

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

涉及 UI 或主进程行为的改动，除了自动化门禁还要 `npm run dev` 实际走一遍相关路径（弹窗、输入、IPC、工具调用）。需要验证渲染层交互时可用 CDP 驱动真实窗口：`--remote-debugging-port=9222` 启动后通过 `Runtime.evaluate` / `Input.dispatch*` 观察。

### Quality Gates

```bash
npm test              # vitest：874 用例 / 49 文件（主进程纯逻辑 + Agent 行为 + SQL 与迁移 + 渲染层纯函数 + mac 真实 Seatbelt 拦截）
npm run test:coverage # vitest + v8 覆盖率（范围见 vitest.config.ts）
npm run typecheck     # 双 tsconfig：main/preload + renderer
npm run lint          # ESLint 9 flat config（基线非零，改动不应新增 error）
npm run build         # typecheck + 三进程构建
```

### Build

```bash
npm run build:win     # Windows
npm run build:mac     # macOS
npm run build:linux   # Linux
```

### Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)
