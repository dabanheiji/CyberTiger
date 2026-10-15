# Repository Guidelines

CyberTiger —— 基于 Electron 的桌面 AI 助手：多会话聊天 + ReAct Agent（工具调用）+ Skills（`SKILL.md` 指令插件）+ MCP（stdio / Streamable HTTP）工具接入。模型走 OpenAI 兼容接口（`baseUrl` 可配，兼容 Ollama / DeepSeek 等）。

## Architecture & Data Flow

三进程 Electron 应用，主进程严格分层：**renderer → preload router → `ipcMain.handle` → controller（IPC 适配）→ service（业务 + DB）→ 纯逻辑模块**。

- **IPC 请求链**：渲染层只经 `window.api`（preload router）调用；`src/main/ipc/index.ts` 集中注册全部 handler，频道命名统一 `域:动作`（`chat:*` / `skills:*` / `agents:*` / `mcp:*` / `settings:*`）。
- **一次 Agent run**：`chat:generateReply` 同步返回 `runId` → 后台 `runAgent`（`src/main/agent/loop.ts`，ReAct，`MAIN_AGENT_MAX_STEPS = 10`）循环「推理 → 工具调用 → 观察」→ 每步落库并经 `chat:stream` 事件流式回推渲染层 → `chat:abortReply` / 退出时 `abortAll()` 中止。同一 run 内**同名 + 同参数**的工具只真正执行一次（模型有时会为「更新」重复发起同一调用），命中缓存的那次 `tool_result.reused = true`，界面显示「已复用本轮结果」。第 2 步起每步会把当前请求重新贴到消息末尾做**目标锚定**，避免多步之后跑偏到历史里的别的话题；锚定同时声明「已拿到的工具结果不需要重新获取」，因为它以 user 角色重复了请求，形似一条新提问，小模型会把这一步已经做过的事重做一遍。每步结束还会发一条 `usage` 事件（本步 token 用量 + 这次裁剪做了什么），与那步的 assistant 行一一对应。压缩检查有两处：`startRun` 组历史之前查一次（请求前自动压缩），每步工具执行完再问一次（`compaction` 注入点，收尾步不压——下一步不给工具、本来就小，压了反而把要用的结论摘没）。越线即压，压完 loop 就地把手上的上下文换成「新摘要 + 没被覆盖的后缀」，此后每一步从这个新前缀继续，并向渲染层发一条挂在触发它那一步的 `compact` 事件（事件照发，界面不再堆进占用环——见「流式事件」那条）。
- **上下文预算与用量计量**：请求消息在发出前由 `agent/context.ts` 的 `planContext()` 压进预算（`budgetFor(contextWindow)` = 窗口 × 85% − 4k 输出预留；`contextWindow` **来自当前模型**的 `ModelConfig.contextWindow`，没配就用 `DEFAULT_CONTEXT_WINDOW = 131072`——不再有全局窗口设置，换服务商 / 换模型都会自动跟着变，子 Agent 则用自己角色的那个模型算窗口）。裁剪按代价从小到大三级：整轮丢最旧的历史 → 缩写超长消息（只动 `content`，**绝不动 `tool_calls.arguments`**）→ 最近一轮内部弃掉较早的连续步骤。**「一轮」「一个单元」是分组单位**（一条 user 起一轮；一次 assistant 输出连同它发起的全部 tool 结果为一个单元），所以丢弃在结构上不可能造出孤儿 `tool_calls`——本项目踩过这个坑，别改成按条裁剪。`system`、本次请求原文、循环控制消息（收尾提示 / 目标锚定）永不参与丢弃，锚定始终排在最后（它靠「近期性」起作用，排到历史前面就失效）。真实用量优先取端点上报的 `chunk.usage`（`stream_options.include_usage`，不支持时自动降级不带它重试），拿不到才退回 `tokens/estimate.ts` 的估算并标 `estimated`；两个数都落进 `messages` 的 `prompt_tokens` / `completion_tokens` / `tokens_estimated`，界面显示「上下文 8k/32k(25%) · 输出 120 · 已省略 N 轮历史」——分母取自**当前模型**的窗口（`contextShare()`），子 Agent 面板可能跑的是别的模型，宁可只写分子也不摆一个假分母；输入框旁边的上下文占用环（`ContextRing`，antd `Progress type="circle"` + `showInfo={false}`，环上不写数字；`Popover trigger="click"` 里**只有**「已用 / 窗口 / 百分比」这一行标题和那颗「立即压缩上下文」按钮——裁剪点、触发线、压缩账目都不堆在环上，结论由聊天页的 `message` 提示说给用户，用 Popover 而不是 Tooltip 是因为按钮要能点；`size` 小于等于 20 时 antd 会给根节点加 `ant-progress-inline-circle`，但它仍是 `inline-flex`——会跟同行高的基线排版、被顶离垂直中线，所以 `styles.root` 要覆盖成 `display: 'flex'` 才能和模型下拉框对齐；描边宽度不写，让 antd 按「不小于 3px」自动算）配 `lib/contextUsage.ts` 的纯函数，用同一套 `budgetFor` 算出裁剪点，超裁剪点转红、≥70% 转黄。
- **上下文压缩（摘要 + 水位）**：`agent/compact.ts` 把「水位之后的老对话」交给模型总结成一段摘要，此后请求的形状是 `[system + 工具] → [摘要块] → 水位之后的原文`——摘要块固定在头部、原文只追加，所以前缀逐字节稳定、能吃到提示缓存；而 `planContext` 的裁剪会改写消息、每步重算，常态下不该动手，只兜「摘要之后仍装不下」（例如某条工具结果自己就几万 token）。所有比例相对**模型配置的窗口**而不是裁剪后的额度（`DEFAULT_COMPACT_POLICY`：触发线 0.8 / 压后目标 0.35 / 单次摘要请求自身上限 0.6 / 摘要正文上限 1200 token / 少于 3 个单元不压 / 省不到 15% 不压 / 一次最多 4 次调用）。`planCompaction` 从最新往回收出**最长后缀**，最新那个单元无条件保留：要摘要它就得把它也发给模型，同样的窗口未必装得下，而丢掉它等于答非所问。`force` 只越过触发线这一条——单元数与收益不足照样拒，那种情况压完省不出空间还白烧一次调用。边界一律落在 `agent/turns.ts` 的单元上，与裁剪共用同一份分组规则，所以水位结构上不可能切在「有 tool_calls 无响应」中间（摘要的输入本身残缺、新水位又永久跳过那半截，等于把协议错误固化）。**摘要失败、被中止或返回空正文一律算整次压缩失败，不写水位**——宁可下一轮超限由裁剪兜底，也不用半截摘要冒充完整摘要（那比超窗更难排查）。分段是滚动的：每段请求 = 指令 + 上一段的结果 + 本段原文，第二次压缩才不会把第一次的摘要丢掉；超出段数上限的更早历史不静默消失，由 `earlierDigest` 抽出标识清单（URL / 路径 / 文件名 / 反引号片段 + 用户在那段问过什么）接在摘要末尾并明说细节可能缺失。**任务执行中途压缩**靠 `taskStateNote` 的执行状态便签：本轮目标 / 第几步共几步还剩几步 / 已执行的工具与结论 / 最新助手输出，作为**待摘要内容之后**的一条 user 消息送进模型，于是自然落进摘要的「进行中」一节——没有它，压完续跑会把做过的工具再调一遍。子 Agent **不做压缩**（不传注入点）：它的上下文就是自己那份任务，压掉的过程它自己还要用。水位不删行，写进 `conversations` 的 `summary` / `summary_until` / `summary_usage` 三列（第三列是「上次压了什么、省多少、花多少」的账目，留作审计与以后界面复用的余量，不参与任何判断；当前渲染层不读它，手动压缩的结论直接用 IPC 返回的那份），历史按 `chatSql.messages.listTopLevelAfter` 读，`summary_until` 为空即退化全量回放。三个压缩时机共用 service 的 `compactUnits`：请求前自动、run 中途（带便签，单元与规模由 loop 现算，因为它手里就是下一步要发出去的那份上下文，本轮攒的工具结果是请求前那次看不见的）、手动按钮（`chat:compactContext`，摘要正文与覆盖单元数由 `toReport()` 摘掉——摘要已在库里，再发往渲染层只是白占一次序列化）。手动压缩不许与 run 并发（`hasActiveWork`：两边都在推进同一个水位，会互相踩出错误的边界），而摘要调用本身也登记进 `activeRuns`，好让退出应用 / 删会话时同样被中止。
- **子 Agent**：`runAgent` 是通用的，靠 `RunScope`（`chat/dto.ts`）区分主 / 子 run。主 Agent 额外持有 `task` 工具（`agent/task.ts`，由 `chat/service.ts` 现构造并注入 spawner），派生出**独立上下文**的子 run：自己的 system prompt、空白历史、裁剪过的工具集（`createToolRunner` 限定查找范围，并从父池剔除 `task` → 结构上不可能递归）、同一个 `AbortSignal`。子 Agent 的最终回答作为 `task` 的 tool_result 回传；其每一步都带 `parent_call_id` 落库与推流，前端在对应工具调用下内联展开。子 run 不发 `done` / `error`，失败由父级 tool_result(`ok=false`) 表达。角色名解析不到时**回退到通用角色**并 `console.warn`，不让整轮子任务失败（`task` 的 `agent` 参数在无可选角色时干脆不暴露，取值用 `enum` 钉死）；子 Agent 拿得到 `load_skill` 时才把 skill 目录拼进它的 system prompt，否则它会凭空猜技能名。
- **工具注入**：`getAllTools()` = 内置工具 + 已连接 MCP 工具（实时合并）；每次 run 用 `createToolRunner(definitions)` 拍快照，`execute` 只在快照内查找（未授权工具名会被当作未知工具，不会直通全局）。内置那一档现在是 `get_current_time` + `load_skill` / `read_skill_file` + `read_file` / `write_file` + `run_command`，**声明序就是下发序**（tools 排在请求前部，插到中间会把提示缓存打掉，所以新工具追加在末尾）。**这三个文件 / shell 工具锚在「会话工作空间」上，但没有硬沙箱**：`ToolContext.workspace`（取自 `conversations.workspace`，`startRun` 读一次随整轮固定、父子 run 同一目录；空串即未选择）决定相对路径与 `run_command` 缺省 cwd 的基准，未设置时退回 `process.cwd()`——与加这列之前的行为一致。**绝对路径与 `~` 开头的路径仍可越界**：照常读写执行，只在结果末尾追加一行 `[注:… 在本次会话的工作空间 … 之外]`；越界判定是 `tools/paths.ts` 的 `anchor` 用 `path.resolve` + `path.relative` 做的**纯文本**比较，**不走 `fs.realpath`**（macOS 的 `/tmp → /private/tmp` 会被误判越界，代价只是多标注一次，而 realpath 要额外 IO 与失败分支）。不弹确认，只有工程护栏（超时默认 30s 上限 600s、stdout/stderr 各留末尾 16k 字符、二进制与 >2MB 文件拒绝、`write_file` 缺 `content` 参数就拒绝执行以免清空文件）；硬沙箱与执行前确认是下一步要做的事，届时以 `workspace` 为地基接上。该目录还由 `prompt.ts` 的 `workspaceNote` 追加进主 / 子 Agent 的 system prompt（陈述式，同样不写祈使），代价是**换目录会打掉该会话的 system 前缀、损失一次提示缓存命中**——低频操作，且换目录后本就该重看上下文，可接受。长耗时工具靠 `ToolContext.signal` 拿本次 run 的 `AbortSignal`（loop 在调用点透传）杀掉进程组——否则 loop 已不再等结果了，进程还在后台改文件。Skills 走两条独立路径——① 渐进式加载：system prompt 里放启用 skill 的 name/description 目录，模型按需调 `load_skill`；② `/` 手动触发：skill 名写入 `messages.skill`，`buildHistory` 展开成 `[Skill: xxx]` + 正文。子 Agent 角色目录（`agents/*/AGENT.md`）同样以 name/description 注入，模型通过 `task` 的 `agent` 参数选用。
- **模型服务商**：模型配置按服务商组织（`AppSettings.providers`：各自一套 `baseUrl` / `apiKey` / 模型清单），当前选择是结构化的 `ModelRef{providerId, model}`。**上下文窗口是逐模型的**（`ModelConfig{ name, contextWindow? }`），没有全局设置项；`contextWindow` 缺省即按 `DEFAULT_CONTEXT_WINDOW` 算，`resolveConnection` 会把它随连接一起带出（`ResolvedConnection.contextWindow`）供 `budgetFor` 使用。候选清单**不是白名单**（`resolveConnection` 不校验模型在不在清单里）。一次 run 由调用方显式传入 `providerId`，主进程经 `resolveConnection` 解析成连接信息——不读全局当前选择，换服务商不会影响正在跑的那轮。`store/migrate.ts` 有两步幂等迁移：单服务商时代的 `baseUrl` / `apiKey` / `models` 搬进 `providers[0]` 并删除旧键；`models: string[]` 升级为 `ModelConfig[]`，并把已废弃的全局 `contextWindow` 只贴在当前选中的那个模型上、随后删除该键（升级后不再读全局值，所以两步必须各自幂等）。
- **持久化**：对话数据在 SQLite（`cybertiger.db`，better-sqlite3）；应用配置在 electron-store（`config.json`）。状态单向推送：`fs.watch`（skills / agents）、MCP 事件、流式事件。
- **消息表的分层读取**：`messages` 用 `parent_call_id` / `depth` / `agent` 三列表达嵌套。渲染层走 `chatSql.messages.list`（全量，才能还原嵌套）；**Agent 历史必须走 `listTopLevel`**——把子 Agent 的 assistant / tool 行一并回放会产生脱离 `task` 上下文的孤儿 tool 行（违反 OpenAI 协议）并把子过程灌回主上下文。压过的会话改用 `listTopLevelAfter`（同一套排除 + 水位过滤，水位行按 `rowid` 比较，水位为空即退化全量）：压缩**不删行**，所以界面随时能看到全过程，而发给模型的只有摘要 + 水位之后的内容。

## Key Directories

| 路径 | 用途 |
|---|---|
| `src/main/chat/` | 聊天核心：`service.ts`（会话/消息 + run 管理 + **压缩编排**：`compactUnits` 三个时机共用、水位读写、`hasActiveWork` 互斥；会话工作空间的读写 `getWorkspace` / `setConversationWorkspace` 也在这层，切换前先过 `hasActiveWork`——一个 run 的基准目录在 `startRun` 就固定，中途改会让相对路径两边不一致）、`controller.ts`（IPC 适配，含 `chat:pickWorkspace` 的目录弹窗）、`llm.ts`（流式调用 + 多供应商 reasoning / usage 归一 + 不支持参数时的降级重试）、`dto.ts`（**跨进程契约源**）、`sql.ts`（全部 SQL 常量 + 行类型） |
| `src/main/agent/` | `loop.ts`（通用 ReAct 循环 + `RunScope` + `AgentStore` 接口 + `compaction` 注入点）、`turns.ts`（**轮与单元分组规则的唯一实现**，裁剪与压缩共用）、`context.ts`（上下文预算与三级裁剪）、`compact.ts`（摘要边界选择 `planCompaction` + 滚动分段摘要 `compactConversation` + 执行状态便签 `taskStateNote`）、`task.ts`（`task` 工具与 `SubAgentSpawner`）、`history.ts`（请求消息组装 / skill 与角色目录 / volatile 结果替换；`systemPromptMessage` 与 `historyBody` 是导出的同源构造件，让「发给模型的历史」与「送去摘要并决定水位的消息」不必分两次转换）、`prompt.ts`（主 / 子 Agent 的中文 system prompt，含 `workspaceNote`：把工作空间那一节追加在 `SYSTEM_PROMPT` 之后、目录之前） |
| `src/main/tokens/` | `estimate.ts`（token 估算与 `formatTokens`；**主进程与渲染层共用**的纯函数） |
| `src/main/tools/` | `registry.ts`（注册 / 查找 / 执行）、`types.ts`（`ToolDefinition` 与 `ToolContext`——后者带本次 run 的 `signal` 与 `workspace`）、`time.ts`（内置工具示例）、`files.ts`（`read_file` / `write_file`）、`shell.ts`（`run_command`）、`paths.ts`（`~` 展开、`anchor` 的工作空间锚定与越界判定、`annotate` 那句越界说明、errno 中文化、存在性探测——文件与 shell 工具共用） |
| `src/main/skills/` | `registry.ts`（目录扫描 / 读取）、`parser.ts`（frontmatter 校验）、`installer.ts`（GitHub/URL/本地安装）、`tools.ts`（`load_skill` / `read_skill_file`）、`controller.ts`（IPC） |
| `src/main/agents/` | `builtin.ts`（内置通用角色）、`parser.ts`（`AGENT.md` 校验与序列化）、`registry.ts`（扫描 / 启停 / 增删改，目录为唯一事实来源）、`controller.ts`（IPC） |
| `src/main/shared/` | `frontmatter.ts`（skills 与 agents 共用的 frontmatter 解析与 name 校验） |
| `src/main/mcp/` | `manager.ts`（连接生命周期）、`config.ts`（zod 校验）、`controller.ts`（IPC） |
| `src/main/database/` | `index.ts`（初始化 + 迁移执行）、`sql.ts`（DDL + 迁移定义） |
| `src/main/store/` | electron-store 实例与 `AppSettings` 类型、`providers.ts`（服务商查询与连接解析，含逐模型窗口的取出）、`modelRef.ts`（**主进程与渲染层共用**的纯逻辑：引用收敛 / `contextWindowOf`）、`migrate.ts`（一次性配置迁移，幂等） |
| `src/main/window-state.ts` | 窗口大小/位置的持久化与启动还原（读写 `AppSettings.windowState`，含多显示器校验与最大化标记） |
| `src/main/ipc/index.ts` | 全部 IPC handler 注册入口 |
| `src/preload/router/` | 按域拆分的 invoke 封装 + 事件订阅（`onStream` / `onChange` / `onStatus`） |
| `src/renderer/src/pages/` | `chat/`（`index.tsx` 状态中枢：手动压缩走 `chat:compactContext`，返回值经 `compactResultLine` 原样说给用户——压没压都要说一句，静默返回等于什么都没发生；工作空间按 `activeId` 分两条写路径——草稿态只写 `settings.defaultWorkspace`（建会话时由 service 抄进那一行），已建会话写 `chat:setWorkspace` 再刷新会话行；`ChatPanel.tsx` 输入与气泡，底栏在模型 Select **之前**放 `WorkspacePicker`（无边框按钮 + `Dropdown`：选择文件夹 / 最近使用 / 清除，`disabled={sending}` 与服务端同一条守卫）、`Sidebar.tsx`（会话列表按**工作空间分组**：`items` 每条带 `group`，`groupable.label` 把组标题渲染成「文件夹图标 + 末段目录名（全路径 Tooltip）+ 一颗右对齐的 `+`」。点 `+` 走的是草稿态那条写路径——`newConversation()` 先把 `activeIdRef` 归 null，`applyWorkspace(dir)` 才会写 `settings.defaultWorkspace` 而不是去改某个已有会话的行；**不当场建会话行**，否则用户点一下只是看看就多出一条空对话。组顺序由每组最新那条会话的位置决定（列表本身按 `updated_at` 倒序，不用再排序）；折叠**保留**（`groupable.collapsible: true`，点整行标题开合），但组件画在行尾的旋转箭头用 CSS `display:none` 隐掉了——开合状态改由标题前的文件夹图标表示（展开 `FolderOpenOutlined` / 收起 `FolderOutlined`），一个信息不留两个控件。折叠状态存「收起了哪些组」而不是「展开了哪些组」，因为组件的 `defaultExpandedKeys` 是空数组＝全收起，而新出现的组要默认展开；`+` 的 `onClick` 必须 `stopPropagation`——整行标题就是折叠开关）），`settings/`（`index.tsx` 把四个配置域拆成 tabs：模型服务 / MCP / Skills / 子 Agent，默认停在模型服务；模型服务是 `ProvidersPanel.tsx` + `ProviderFormDrawer.tsx` 的服务商增删改（抽屉里模型是嵌套 `Form.List` 行：模型名 + 该模型的上下文窗口，清空窗口即回落到默认值；子 Agent 的模型选择器按 `providerId/model` 作 key 列出全部服务商的模型），子 Agent 是 `AgentsPanel.tsx` + `AgentFormDrawer.tsx`） |
| `src/renderer/src/hooks/` | `useAgentStream`（订阅 `chat:stream`，维护含子 Agent 的步骤树；`compact` 事件被显式消费成 no-op——界面不展示它，但那条 case 不能删，否则事件落到 switch 末尾把整轮流式状态清空）、`useSkills`、`useAgents`、`useSystemTheme` |
| `src/renderer/src/components/` | `AgentSteps`（把一次回复的多步 ReAct 合并成「一个思考框 + 一条工具链 + 正文」，主气泡与子 Agent 面板共用、递归嵌套）、`ToolCallChain`、`ReasoningBox` |
| `src/renderer/src/lib/` | `agentSteps.ts`（步骤树的纯函数：按 id 查找 / 不可变替换 / 中止态标记 / `toStepUsage` 与 `summarizeUsage` 把各步用量汇总成一行，`useAgentStream` 与聊天页共用）、`contextUsage.ts`（上下文占用环的纯函数：从流式步骤或历史消息取「本次请求的 prompt」，配当前模型窗口算出比例与告警档位，`contextShare` 给气泡 footer 拼分母；压缩那一截只剩手动按钮的结论文案——被拒原因 `compactReasonText` 与一行 `compactResultLine`。触发线比例、裁剪点说明、上次压缩账目都**不**再复制到渲染层：环的 Popover 只报「已用 / 窗口 / 百分比」，那边 `agent/compact.ts` 才是压缩的执行者与账本）、`workspace.ts`（底栏选择器与侧栏分组的纯函数：`workspaceLabel` 取路径末段名（空值给「未选择工作空间」）、`pushRecent` 的最近使用去重与上限、`workspaceGroupKey` / `workspaceGroupDir` 的分组键与哨兵 `NO_WORKSPACE_GROUP`——`Conversations` 把空 `group` 当作「这条不分组」，所以未选工作空间那批会话也必须有个非空键，否则它们会散落在各组之间、连组标题和「+」都没有） |
| `test/` | vitest 用例（`test/main/**` 主进程、`test/renderer/**` 渲染层纯函数）、`test/stubs/`（electron / electron-store / better-sqlite3 的运行时替身）、`test/helpers/`（脚本化模型与假 `AgentStore`、临时目录与内存库工具、设置复位） |

## Development Commands

```bash
npm install                 # postinstall 会重建原生模块 (electron-builder install-app-deps)
npm run dev                 # 开发启动（electron-vite dev，HMR）
npm run build               # typecheck(node+web) + electron-vite build → out/
npm run build:mac           # 打包 macOS（build:win / build:linux 同理）
npm run typecheck           # tsc --noEmit 跑 tsconfig.node.json + tsconfig.web.json
npm run lint                # ESLint 9 flat config
npm test                    # vitest run（单进程 node 环境，用例在 test/）
npm run test:watch          # vitest watch
npm run test:coverage       # vitest + v8 覆盖率（范围见 vitest.config.ts）
npm run format              # Prettier 全仓格式化
npm run start               # electron-vite preview（跑构建产物）
```

调试用 `.vscode/launch.json`：`Debug Main Process`（electron-vite）与 `Debug Renderer`（Chrome attach `127.0.0.1:9222`）可组合成 `Debug All`。主进程调试端口由 `REMOTE_DEBUGGING_PORT=9222` 控制。

## Code Conventions & Common Patterns

- **语言**：注释、提示词、用户可见错误信息均为中文；注释用 TSDoc `/** */`，解释「为什么」而非复述代码。
- **格式**（Prettier / EditorConfig 强制）：单引号、无分号、`printWidth 100`、无尾逗号、2 空格缩进、LF、文件末尾换行。
- **ESLint 硬约束**（`@electron-toolkit/eslint-config-ts`）：所有函数必须显式返回类型（`explicit-function-return-type: error`，含箭头函数与 React 组件 → `React.JSX.Element`）；禁止 `any`；`@ts-ignore` 必须附说明。
- **IPC 契约**：handler 返回 `IpcResult<T> = { success: true; data: T } | { success: false; msg: string }`，用统一包装器捕获异常（`chat/controller.ts` 的 `run()`、`skills/controller.ts` 的 `run()` / `runAsync()`）。**例外**：`settings:*` 直接返回原始值，无 `IpcResult`。
- **SQL 集中**：所有语句写在对应 `sql.ts` 里导出为常量（如 `chatSql.messages.list`），不在业务代码内联拼接。SCHEMA 变更必须走 `src/main/database/sql.ts` 的 `columnMigrations`（加列）或 `tableRebuilds`（改约束）——`CREATE TABLE IF NOT EXISTS` 对已有库不生效。加一列要同时改三处：`initSql` 的建表、`columnMigrations` 里那条 `ALTER ... ADD COLUMN`（新库靠建表、老库只认迁移，两边都得带 `NOT NULL DEFAULT`，否则老行读成 `null` 而不是默认值）、`chat/sql.ts` 的行类型（`listConversations()` 走 `SELECT *`，漏改由 tsc 报出来）。**不属于「用户对话活动」的写入不要动 `updated_at`**——`setSummary` 与 `setWorkspace` 都不碰它，否则压缩一次、切一次目录就把会话顶到列表最前，那是错的排序信号。
- **依赖注入**：纯逻辑模块不直接依赖 DB。`agent/loop.ts` 通过 `AgentStore` 接口接收落库操作，实现由 `chat/service.ts` 注入。
- **流式事件**：主进程 → 渲染层的事件统一用判别联合类型 `ChatStreamEvent`（`step_start` / `delta` / `tool_call` / `tool_result` / `usage` / `compact` / `done` / `error`），定义在 `chat/dto.ts`；渲染层按 `type` 分支消费。事件都带 `RunScope`（含 `parentCallId` / `depth`），子 Agent 的步骤据此挂到父级工具调用下；`tool_result.reused` 标记本次命中了本轮内去重缓存；`usage` 带本步的 `TokenUsage`（`estimated` 区分端点上报还是本地估算）与 `ContextMeter`（这次裁剪丢了什么）；`compact` 带那次压缩成功与否、`TokenUsage`、`SummaryMetrics` 账目与失败提示（字段叫 `msg`，与 `IpcResult` 同一条纪律：面向用户的中文，别新增第二个同义字段名）。`compact` 与按 `messageId` 定位的那几类不同，它**不改 steps、也不进任何界面**——占用环的 Popover 只报「已用 / 窗口 / 百分比」加那颗按钮，压缩的结论要么在手动路径的 `message` 提示里，要么留在会话行的账目里。所以 `useAgentStream` 把它消费成 no-op；这条 case 是**承重的**：switch 末尾那句「run 收尾时清空流式状态」会吃掉所有没被匹配的分支，删掉 case 就等于压缩发生时把整轮已流出的内容抹掉。它同样可能早于 IPC 应答（请求前那次赶在渲染层登记 `runId` 之前），无所谓——没有任何显示依赖这条事件。**第一步的事件早于 IPC 应答**：`runAgent` 在 `await stream()` 之前的同步前缀里就 `emit({type:'step_start'})`，而 `chat:generateReply` 的 `emit` 是 `sender.send`——事件比 handler 的返回值更早投递（实测 200 次里 199 次先到），渲染层那时还没登记 `runId`，那条 `step_start` 必然被 runId 过滤丢掉。所以按 `messageId` 定位的事件（`delta` / `tool_call` / `usage`）在消费前都要先过 `lib/agentSteps.ts` 的 `ensureStep()` 把落单的步骤补出来（`mapStep` 找不到 id 时是静默 no-op，早先因此让「一步就答完」的回复完全看不到流式过程）。落单的一定是最新那一步，所以补在末尾/父调用下就是正确位置；父级调用不存在时**不补建**，否则子 Agent 的正文会混进主上下文。
- **错误处理**：工具执行 `executeTool` **永不抛错**，失败返回 `{ ok: false, result: 说明 }` 交给模型自纠；LLM 错误经 `toReadableMessage` 归一为面向用户的中文提示；skill 已被删/禁用时退化为普通消息，不中断对话。
- **给模型看的文案只用陈述句，绝不写「请重新调用 / 每次都必须调用」这类祈使**：模型会把祈使当成本轮待办去执行。这个项目踩过两次——① `agent/history.ts` 的 `STALE_RESULT_PLACEHOLDER` 旧文案「如需该信息请重新调用工具」，模型读完转头重查时间并回答了时间；② `tools/time.ts` 描述结尾「每次被问到时间都必须重新调用」，让一句问话变成三步重复调用（工具描述每步都随请求整份下发，比 system prompt 更靠近、更具体，两者冲突时它赢，而 `prompt.ts` 第 3 条写的恰好是「不要重复调用」）。**跨轮重取靠 `volatile` 标记 + 历史占位符在结构上保证，不靠文案催促。**
- **异步模式**：串行化写操作（如 `skills/installer.ts` 的 `serialized` 队列）、防抖重扫（`skills/registry.ts` `scheduleRescan` 300ms）、资源清理用 `finally`。
- **前端状态**：无全局状态库。页面级 `useState` + `useRef`（ref 用于异步回调读取最新值，避免闭包过期）；跨组件复用逻辑放 `hooks/`；组件库统一用 antd 6 / `@ant-design/x`。
- **前端样式覆盖**：antd v6 样式包在 `:where(...)` 中（优先级 0），普通类选择器即可覆盖，**无需 `!important`**；需要选中间层 DOM 时用组件库的 `classNames.*` 语义槽（如 `Suggestion` 的 `classNames.popup` → 弹层根），再在 `assets/main.css` 写后代选择器。先例见 `.cybertiger-skill-dropdown` 与 `.cybertiger-conversations-group`（后者是侧栏会话列表的分组标题：`Conversations` 的 `classNames.group` 落在那个 `<li>` 上、`styles.group` 却落在组内的 `<ul>`，所以组标签缺的那条 flex 宽度链只能用后代选择器补，`ellipsis` 才生效）。
- **跨进程共享类型**：渲染层直接 import 主进程的纯类型文件，但**必须同步登记进 `tsconfig.web.json` 的 `include`**（目前 9 个文件：`chat/sql.ts`、`chat/dto.ts`、`agent/context.ts`、`mcp/types.ts`、`skills/types.ts`、`agents/types.ts`、`store/types.ts`、`store/modelRef.ts`、`tokens/estimate.ts`）。新增共享类型文件若漏登记，web 侧类型检查会失败。反过来，**依赖主进程运行时（DB / electron / 工具注册表）的模块不能进这份清单**——`agent/compact.ts` 就不行，所以渲染层要用的触发线比例在 `lib/contextUsage.ts` 里同值复制一份。

## Important Files

- `src/main/index.ts` —— 主进程入口（注册 IPC、初始化 MCP/Skills/Agents、窗口、退出清理）
- `src/main/ipc/index.ts` —— 全部 IPC handler 注册
- `src/main/chat/dto.ts` —— 跨进程数据契约（DTO / 事件 / `IpcResult`）
- `src/main/agent/loop.ts` / `src/main/agent/task.ts` —— 通用 Agent 主循环、`AgentStore` 接口与 `task` 派生工具
- `src/main/agent/context.ts` / `src/main/tokens/estimate.ts` —— 上下文预算与裁剪（`planContext` / `budgetFor`）、token 估算与界面显示格式
- `src/main/agent/compact.ts` / `src/main/agent/turns.ts` —— 上下文压缩的边界选择与摘要调用（`planCompaction` / `compactConversation` / `taskStateNote` / 摘要块），以及裁剪与压缩共用的轮/单元分组规则
- `src/main/tools/registry.ts` —— 工具注册与执行入口（新增内置工具在此挂载；文件与 shell 工具在 `files.ts` / `shell.ts`，两者共用的路径与 errno helper 在 `paths.ts`）
- `src/main/skills/parser.ts` / `src/main/agents/parser.ts` —— `SKILL.md` / `AGENT.md` 规范校验（`name` 必须 kebab-case 且等于目录名；agents 额外校验 `model` / `tools`）
- `src/main/store/providers.ts` / `src/main/store/migrate.ts` —— 服务商解析与配置结构迁移
- `src/main/database/sql.ts` —— 建表 DDL 与迁移定义
- `src/main/database/migrate.ts` —— 迁移执行（`MigrationDb` 最小接口，测试用内存库跑同一套）
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

vitest 5（`npm test`），配置 `vitest.config.ts`，用例在 `test/`（`test/main/**` 对应主进程、`test/renderer/**` 对应渲染层纯函数）。仍是单 node 环境，没有 jsdom / playwright，UI 组件不测。

- **运行时替身**：`resolve.alias`（必须用**数组 + 精确正则**，对象 alias 是前缀匹配，`electron` 会顺手吃掉 `electron-store`）把 `electron`、`electron-store`、`better-sqlite3` 换成 `test/stubs/*`。tsc 不读 alias，类型检查仍按真实依赖走，所以业务代码新用某个 Electron API 时要同步补 stub —— `test/main/boot.test.ts` 会以 import 失败的形态第一时间报出来。`better-sqlite3` 是原生模块，`postinstall` 后是 Electron ABI，Node 里 `require` 会因 NODE_MODULE_VERSION 不匹配直接炸，所以测试里换成"构造即抛错"的替身。
- **数据库**：SQL 行为与迁移全部用 `node:sqlite` 的内存库验证（`test/helpers/sqlite.ts`）。为此 `database/index.ts` 里的迁移函数被抽成 `database/migrate.ts` 的 `MigrationDb` 接口（`exec` / `pragmaRead` / `pragmaWrite` / `select` / `transaction`），主进程用 better-sqlite3 适配，测试用内存库适配，跑的是同一套迁移脚本。
- **文件系统接缝**：`CYBERTIGER_SKILLS_DIR` / `CYBERTIGER_AGENTS_DIR` 指到临时目录后调 `registry.scan()`；**不要调 `init()`**，它会 `fs.watch` 并留下监听句柄。
- **设置单例**：`store` 是模块级单例，用例间会串味，每个用例前用 `test/helpers/settings.ts` 的 `resetSettings()` 复位。
- **Agent 循环**：`runAgent` 的 `stream` 参数可注入脚本化模型（`test/helpers/agent.ts` 的 `makeModel(script)`，`usage` 字段用来模拟「端点报了真实用量」与「不报」两种情形），落库用 `makeStore()` 的 `AgentStore` 假实现，事件用 `makeEmit()` 收集；工具集用**真实** `createToolRunner` 组装，这样参数校验与未知工具拒绝也一并被覆盖。传 `budget` 就能用小预算触发裁剪，并断言每条被压缩过的请求都没有孤儿 `tool_calls`。测试里绝不发真实网络请求。
- **模型层**：`streamChatCompletion` 里 `new OpenAI(...)` 不可注入，用 `vi.mock('openai')` 换掉客户端的 `chat.completions.create` —— **错误类必须仍取真实模块的那些**（`Object.create(OpenAI.BadRequestError.prototype)` 造实例），因为降级分支靠 `instanceof` 判断；真实 chunk 用 async generator 回放。见 `test/main/chat/llm-stream.test.ts`。
- **上下文压缩**：`agent/compact.ts` 的 `compactConversation` 自带 `stream` 注入点，用脚本化模型回放摘要，断言「分段是滚动携带旧摘要的 / 任一段报错、被中止或返回空正文就整次失败且**不给水位** / 段数超上限时 dropped 转成标识清单接在摘要末尾」。`planCompaction` 是纯函数，直接断言边界结论（最新单元无条件保留、`force` 只越过触发线这一条、单元数与收益不足照样拒）。`loop.test.ts` 传一个**假 `compaction`**（脚本化「第几步压、压完覆盖几个单元」）断言送去摘要的单元边界 id 落在单元边界上、执行状态便签写的是本轮真实进度与工具结论、第二次压缩拿到上一份摘要、压缩失败时上下文原样继续、收尾步不调注入点。水位的读写（`listTopLevelAfter` / `commitSummary`）在 `test/main/database/chat-queries.test.ts` 用内存库跑同一套 SQL。
- **写法**：`describe` 对应一个概念组，`it` 的中文描述讲清"行为 + 为什么"。故意保留的问题用 `(已知缺陷)` 结尾命名并写明后果，不要写成通过的样子。

已覆盖：Agent 循环（去重 / 锚定 / 步数上限 / 中止 / 落库 / 用量与裁剪 / **中途压缩** / 工具上下文透传 `workspace`）、`planContext` 三级裁剪（整轮丢弃 / 单元同进同出 / 缩写只动 content / 压不住也照发）、`turns` 的轮与单元分组（裁剪和摘要切在同一处）、`compact` 的边界选择 / 滚动分段 / 失败不给水位 / 执行状态便签 / 摘要块识别、history（skill 与角色目录、易变工具占位、`/` 展开退化、`systemPromptMessage` 与 `historyBody` 的同源构造、带 / 不带工作空间时 system 里那一句以及它不含祈使的回归守卫）、`task` 工具、tools 注册表、时间工具（含「描述文案不得出现诱导重复调用的祈使句」这条回归守卫）、`tools/paths.ts` 的 `~` 展开与 errno 中文化、`anchor` 的工作空间锚定与越界判定（相对路径按 workspace、绝对路径与 `~` 的优先级、子目录不标注、父目录与同级标注、**未选工作空间时一律不标注**，纯文本比较下 symlink 按名字判）、文件工具（分段读的 offset 推进 / 覆盖与追加各说什么 / 缺 `content` 就不碰原文件 / 二进制与大文件拒绝 / 给了 `ctx.workspace` 时相对路径落在其中、没给则退回 `process.cwd()` / 越界那行标注）、shell 工具（非零退出码不算工具失败 / 超时与中止都杀掉整个进程组且仍回传已产出内容 / stdin 关闭让 `cat` 这类读输入的命令不挂起 / 输出只留末尾 / 缺省 cwd 就是工作空间）、skills 与 agents 的 parser / registry / installer、建表与迁移（含 `conversations.workspace` 补列的幂等与旧行读到空串）、`chatSql` 分层读取 + 摘要三列与水位 + `workspace` 的读写（含「切目录不挪 `updated_at`」）+ `tool_calls` JSON 往返、`normalizeDelta` / `normalizeUsage` 与降级重试链、token 估算器、`store/migrate.ts` 的两步幂等迁移（含半升级的混合形状清单，防「重建时丢掉已配好的窗口」）、`store/providers.ts` 的连接解析（含「候选清单不是白名单」这条守卫）、渲染层 `agentSteps` / `modelRef` / `contextUsage`（含手动压缩结论与被拒原因的那两句文案）/ `workspace`（末段名、最近使用清单、分组键与「未选工作空间」那个非空哨兵）。**未覆盖**：`chat/service.ts` 里压缩的编排接线（`compactUnits` / `compactBeforeRun` / `createRunCompactor` / 手动压缩的并发守卫，它要 DB 与 electron-store 单例）、`chat/service.ts` 里工作空间的接线（`startRun` 读一次随整轮固定、`createFirstMessage` 把 `defaultWorkspace` 抄进新建的会话行——同样要 DB 与 store 单例）、controller 与 preload 的 IPC 适配（含 `chat:compactContext` / `chat:pickWorkspace` 的目录弹窗 / `chat:setWorkspace` 的占用守卫）、`window-state`、MCP 连接生命周期与真实下载（`installer` 的远程分支）、所有 React 组件（含占用环的 `Popover` 与那颗按钮、底栏的 `WorkspacePicker`、侧栏的分组标题与那颗「+」——分组、组顺序与标签都由 `Conversations` 按 `group` 字段自己聚合渲染，只能靠 CDP 驱动真实窗口验证）、`read_file` / `write_file` / `run_command` 由**真实模型**发起的端到端路径（单测跑的是工具本身与真实子进程，缺的是「模型会不会挑对工具、传对参数」这一环，要 `npm run dev` 实测）。

验证门禁：

1. `npm test` —— 提交前必过（`npm run test:coverage` 看范围数字）
2. `npm run typecheck` —— 双 tsconfig 覆盖 main/preload 与 renderer
3. `npm run lint` —— 注意：**当前基线非零**（约 12 errors，集中在历史文件的 `no-explicit-any` / 显式返回类型）。改动不应新增 error；`test/**` 与 `vitest.config.ts` 已豁免"显式返回类型"。
4. `npm run build` —— `typecheck` + 三进程构建的完整串联
5. `npm run dev` 实测 —— 涉及 UI / 主进程行为的改动，启动应用实际走一遍相关路径（弹窗、输入、IPC、工具调用）。工作空间这一档要覆盖四条：选目录后相对路径读文件落在其中、切会话各用各的目录不串、run 进行中底栏按钮禁用、草稿态选的目录在建会话后仍在。

需要验证渲染层交互且无法人工观察时，可用 CDP 驱动真实窗口：以 `--remote-debugging-port=9222` 启动 Electron，通过 `/json` 拿页面 target 后用 WebSocket 执行 `Runtime.evaluate` / `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent`。注意 `npx electron .`（加载项目 `package.json` → `app.name=cybertiger`）才对应用正确的 userData；直接 `npx electron out/main/index.js` 会让 `app.name` 变成 `Electron`，读到空的 store 与 skills 目录。相同 URL 的 `Page.navigate` 不会重载页面，验证前应重启实例以获得干净状态。**脚本化改 antd 受控输入**（如 `InputNumber`）要用 `input.focus()` → `input.select()` → `document.execCommand('insertText', false, value)` → `input.blur()`：直接赋值 + `dispatchEvent(new Event('input'))` 不会被 React 的 value tracker 认账，`onChange` 不触发，界面看着改了、store 里其实没写。写完后用 `window.api.settings.getAll()` 回读确认，并在同一个脚本的 `finally` 里 `settings.remove(key)` 复原。

