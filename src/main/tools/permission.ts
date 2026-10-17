import path from 'path'
import type { PermissionMode } from '../store/types'
import { commandAllowKey, classifyCommand, commandSegments } from './risk'
import { anchor } from './paths'

/**
 * 工具执行审批的判定:把「操作形状 + 档位 + 黑白名单」合成一个结论。
 *
 * 判定序固定为 **deny → allow → 档位表**:
 * - 黑名单是唯一在任何档位(含「完全访问」)都拦得住的闸门,所以它先问。
 * - 白名单其次:命中即免审批,不然用户配了名单还被追问,名单就等于没配。
 * - 剩下才看档位。
 *
 * 本模块不认识 electron、DB 与渲染层,所以整张表能脱离应用跑单测;
 * 等待用户决定的那一段在 `chat/approvals.ts`,把结论接进工具执行的在 `chat/approval.ts`。
 */

/** `listed` = 不是因为风险、而是因为命中黑名单才审批 */
export type ApprovalRisk = 'low' | 'elevated' | 'listed'

/** 需要审批时要展示给用户的内容;免审批(返回 null)时不需要它 */
export interface ApprovalRequirement {
  /** 卡片标题下第一行,一句话说清要干什么 */
  summary: string
  /** 逐条补充事实:命令行、实际目录、目标路径、风险理由、是不是子 Agent 发起的 */
  detail: string[]
  risk: ApprovalRisk
  /** 「本轮同类都允许」放行的那一类,键本身要显示在按钮上 */
  runAllowKey: string
}

export interface PermissionLists {
  allow: string[]
  deny: string[]
}

export interface ApprovalQuery {
  mode: PermissionMode
  toolName: string
  /** 模型给的原始参数;这里只读审批需要的那几个字段,不做校验(校验归工具自己) */
  args: Record<string, unknown>
  /** 本次 run 的工作空间,空串即未选择 */
  workspace: string
  /**
   * 文件写入 jail 的根;有根即 jail 开着。它在这里**只用来决定要不要问**,
   * 真正的执行边界在 `tools/jail.ts` 与 `tools/files.ts` 那一侧 —— 这一层从不拦操作。
   * 这里只当一个字符串用(**不做任何 IO**),所以这张判定表仍然能脱离应用跑单测;
   * 越界与锚定也继续用纯文本的 `anchor`:jail 那边是另一套判定(realpath),
   * 两套不互抄,于是有两种不对称都站在不打谎那侧 ——
   * 字形界内而真身界外 → 不弹卡片、执行被拒;字形界外而真身界内 → 多问一次、执行成功。
   */
  jail?: { root: string }
  /** MCP 工具来自外部 server,行为不受本项目控制,所以整档纳入审批面 */
  isMcpTool: boolean
  lists: PermissionLists
  /** 子 Agent 发起时是角色名;主 Agent 传空串,只用于卡片上写明是谁在动手 */
  agent: string
}

const READ_FILE = 'read_file'
const WRITE_FILE = 'write_file'
const RUN_COMMAND = 'run_command'

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 名单条目里的 server 前缀写法:以 `__` 结尾,匹配该 MCP server 的全部工具 */
function isServerPrefix(entry: string): boolean {
  return entry.endsWith('__')
}

/** 工具名条目与 server 前缀条目都算「按名字命中」 */
function matchesTool(entry: string, toolName: string): boolean {
  if (!entry) return false
  if (isServerPrefix(entry)) return toolName.startsWith(entry)
  return toolName === entry
}

/**
 * 命令前缀条目按 **token 边界** 比对:条目切成 token,必须是该分段 argv 的前缀。
 * 所以 `git status` 认 `git status --short`,不认 `git status:x`,也不认
 * `git --no-pager status`(选项插在中间就不是那个前缀 —— 宁可多问一次,
 * 不做「顺序无关」的聪明匹配,那种匹配用户猜不到自己配的东西会命中什么)。
 */
function matchesCommandEntry(entry: string, argv: string[]): boolean {
  const tokens = entry.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0 || tokens.length > argv.length) return false
  return tokens.every((token, index) => token === argv[index])
}

/** 逐段比对:任一段命中即算命中 */
function anySegmentMatches(entries: string[], segments: string[][]): boolean {
  return entries.some((entry) => segments.some((argv) => matchesCommandEntry(entry, argv)))
}

/**
 * 命令看不懂(引号未闭合、有替换或重定向)时退回按原文做词边界匹配。
 *
 * 黑名单只用在「任何档位都要拦」这一处,而最危险的命令恰好是解析不了的那批
 * (`cat f > /etc/hosts`):按分段匹配它们会漏过,于是「完全访问 + 黑名单 cat」= 照跑。
 * 所以那一条走这条更宽的路,代价是把 `mycat` 这类同名前缀也当命中 —— 多问一次。
 */
function matchesRaw(entry: string, command: string): boolean {
  const escaped = entry
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+')
  if (!escaped) return false
  return new RegExp(`(^|[^\\w./-])${escaped}($|[^\\w-])`).test(command)
}

/**
 * 白名单要**每个分段都命中**才免审批。
 *
 * 只看第一段是最省事的写法,也是最坏的绕过方式:`ls; rm -rf ~` 的第一段无害,
 * 于是整条被当成「用户在名单里见过 ls」放过去。
 */
function allSegmentsCovered(entries: string[], command: string): boolean {
  const segments = commandSegments(command)
  if (!segments) return false
  return segments.every((argv) => anySegmentMatches(entries, [argv]))
}

interface Operation {
  summary: string
  detail: string[]
  risk: ApprovalRisk
  /** 「本轮同类都允许」放行的那一类 */
  runAllowKey: string
  /** 该操作是否落在审批面内(面内才有「按档位决定是否要问」这回事) */
  inSurface: boolean
  /** 自动审批档能否因为「证明得了安全」而免审批 */
  autoAllowed: boolean
}

/**
 * 把一次调用翻译成人能看懂的一句话,并算出它在审批面里的位置。
 *
 * 未选工作空间时(`anchor` 的 `outside` 恒为 false,没有基准目录就无从「越界」):
 * - `write_file` 一律要审批 —— 没有授权范围就等于没有授权。
 * - `read_file` 免审 —— 判不出越界,这是既有实现的留白;写侧的护栏已经由路径 jail
 *   装上(见 `tools/jail.ts`),读侧还没接进去,仍是留白。
 * 方向不同只是因为「写会改本机状态、读不会」。
 */
function describe(query: ApprovalQuery): Operation {
  const { toolName, args, workspace } = query
  const hasWorkspace = workspace.trim() !== ''
  const fromSubAgent = query.agent ? [`由子 Agent「${query.agent}」发起,不是主 Agent 在动手`] : []

  if (toolName === RUN_COMMAND) {
    const command = stringArg(args.command)
    const target = anchor(stringArg(args.cwd), workspace)
    const risk = classifyCommand(command)
    // 命令本身证明得了安全还不够:工作目录越出去同样是「出了授权范围」
    const cwdOutside = hasWorkspace && target.outside
    return {
      summary: `执行命令:${command || '(空命令)'}`,
      detail: [
        `工作目录:${target.path}`,
        ...(cwdOutside ? ['该目录在本次会话的工作空间之外'] : []),
        ...risk.reasons.map((reason) => `风险:${reason}`),
        ...(typeof args.timeout_seconds === 'number'
          ? [`超时:${String(args.timeout_seconds)} 秒`]
          : []),
        ...fromSubAgent
      ],
      // 命令级风险照实报:ask 档下 `ls` 也要问,卡片就该说它是低风险,否则用户看不出
      // 「这一档为什么要问我一条 ls」
      risk: risk.level,
      // cwd 是模型现填的,键里带上它才不会「放行了 /tmp 的 ls」变成放行所有目录的 ls
      runAllowKey: `${commandAllowKey(command)} [cwd=${target.path}]`,
      inSurface: true,
      autoAllowed: risk.level === 'low' && !cwdOutside
    }
  }

  if (toolName === READ_FILE || toolName === WRITE_FILE) {
    const raw = stringArg(args.path)
    const target = anchor(raw, workspace)
    const writing = toolName === WRITE_FILE
    const outside = writing && !hasWorkspace ? true : target.outside
    // jail 开着时根外的写入会被工具当场拒掉(见 tools/jail.ts),审批不必再问一件注定失败的事。
    // 只收写侧:读侧这一期没进 jail,根外的 read_file 照旧弹卡片。
    // 没选工作空间就没有根,`writing && !hasWorkspace` 那条保守分支因此一字未动。
    const refusedByJail = writing && query.jail !== undefined && target.outside
    return {
      summary: `${writing ? '写入' : '读取'}${outside ? '工作空间之外的' : ''}文件:${raw || '(空路径)'}`,
      detail: [
        `实际路径:${target.path}`,
        ...(outside && hasWorkspace ? ['该路径在本次会话的工作空间之外'] : []),
        ...(writing ? [args.append === true ? '以追加方式写入' : '将整文件覆盖'] : []),
        ...fromSubAgent
      ],
      risk: 'elevated',
      // 按目录放行而不是按单个文件:一个任务常要写同目录下好几个文件,按文件就得逐条问
      runAllowKey: `${toolName} ${path.dirname(target.path)}`,
      inSurface: outside && !refusedByJail,
      autoAllowed: false
    }
  }

  if (query.isMcpTool) {
    const server = toolName.split('__')[0]
    return {
      summary: `调用 MCP 工具:${toolName}`,
      detail: [`来自 MCP server「${server}」,它的行为由该 server 的代码决定`, ...fromSubAgent],
      risk: 'elevated',
      runAllowKey: toolName,
      inSurface: true,
      autoAllowed: false
    }
  }

  // 其余内置工具(get_current_time / load_skill / read_skill_file / ask_user / task)不在审批面内:
  // 前三者不碰本机状态,ask_user 本来就停在用户身上,task 不直接动手、
  // 它派出的子 run 里每一次工具调用各自过闸门。
  return {
    summary: `调用工具:${toolName}`,
    detail: fromSubAgent,
    risk: 'low',
    // 面外的工具不会走到「放行一整类」那一步,键只是把形状补齐
    runAllowKey: toolName,
    inSurface: false,
    autoAllowed: true
  }
}

/**
 * 这次调用要不要问用户。
 *
 * 返回 `null` 即免审批;返回载荷即要问,而载荷里的 `detail` 已经把「为什么要多问一次」
 * 写全 —— 没有理由的审批会被用户无脑点允许,那道闸门就白装了。
 */
export function needsApproval(query: ApprovalQuery): ApprovalRequirement | null {
  const { lists, mode } = query
  const command = stringArg(query.args.command)

  const segments = query.toolName === RUN_COMMAND ? commandSegments(command) : null
  const denyHit =
    lists.deny.some((entry) => matchesTool(entry, query.toolName)) ||
    (query.toolName === RUN_COMMAND &&
      (segments
        ? anySegmentMatches(lists.deny, segments)
        : lists.deny.some((entry) => matchesRaw(entry, command))))
  if (denyHit) {
    const operation = describe(query)
    return {
      summary: operation.summary,
      detail: ['命中黑名单:这一条在任何档位都会先问一次。', ...operation.detail],
      risk: 'listed',
      runAllowKey: operation.runAllowKey
    }
  }

  const allowHit =
    lists.allow.some((entry) => matchesTool(entry, query.toolName)) ||
    (query.toolName === RUN_COMMAND && allSegmentsCovered(lists.allow, command))
  if (allowHit) return null

  if (mode === 'full') return null
  const operation = describe(query)
  if (!operation.inSurface) return null
  if (mode === 'auto' && operation.autoAllowed) return null

  return {
    summary: operation.summary,
    detail: operation.detail,
    risk: operation.risk,
    runAllowKey: operation.runAllowKey
  }
}

/**
 * 收紧立即、放宽下一轮:把「用户刚点的档位」与「本次 run 已固定住的档位」合成一个。
 *
 * 严格序是 `ask > auto > full`,取两者里更严的 —— 正在跑的那一轮可以被用户当场刹住,
 * 但不能被当场放宽(它已经按旧档位跑过几步了)。放在这里而不是 service,
 * 是为了让那条只留接线、这条规则本身能被单测钉住。
 */
const SEVERITY: Record<PermissionMode, number> = { ask: 0, auto: 1, full: 2 }

export function stricterMode(a: PermissionMode, b: PermissionMode): PermissionMode {
  return SEVERITY[a] <= SEVERITY[b] ? a : b
}

/** 给设置页用的名单条目形状说明(唯一一份,界面照抄) */
export const LIST_ENTRY_SHAPES: string[] = [
  '命令前缀:只对 run_command 生效,按 token 边界匹配,且整条命令每个分段都要命中,如 npm run build',
  '工具名:该工具整体免审或必审,如 write_file、github__create_issue',
  'server 前缀:以 __ 结尾,匹配该 MCP server 的全部工具,如 github__'
]
