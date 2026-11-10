/** 输入框里 `/` 开头的命令;每条都在下面那份清单里登记 */
export interface ChatCommand {
  /** 不含前导 `/` */
  name: string
  description: string
}

/**
 * 全部可用命令的清单。
 * 识别与菜单都从这一份派生 —— 各写一份会出现「菜单里有、按回车不认」的漂移。
 */
export const CHAT_COMMANDS: ChatCommand[] = [
  { name: 'compact', description: '把较早的对话压进摘要,腾出上下文空间' },
  { name: 'plan', description: '计划模式:先生成实施计划,审批后再开始改代码' }
]

/**
 * 菜单 value 的命名空间。
 * skill 名是 kebab-case(不含冒号),所以命令与同名 skill 不会互相顶掉。
 */
export const COMMAND_VALUE_PREFIX = 'command:'

/** 整条命令只允许「斜杠 + 字母开头的标识符」,空白与参数都算普通消息 */
const COMMAND_PATTERN = /^\/([A-Za-z][A-Za-z0-9-]*)$/

/**
 * 整条输入恰好是一个已知命令时返回它(忽略首尾空白与大小写);否则 undefined。
 * 只看整条输入:`/compact 这个文件` 与正文里出现的斜杠都不算命令。
 */
export function readChatCommand(text: string): ChatCommand | undefined {
  const matched = COMMAND_PATTERN.exec(text.trim())
  if (!matched) return undefined
  const name = matched[1].toLowerCase()
  return CHAT_COMMANDS.find((c) => c.name === name)
}

/**
 * `/` 之后的那一段过滤词;整条输入不是「斜杠开头的单段文本」时返回 undefined(菜单保持关闭)。
 * 出现空白就不再是命令输入:`/compact foo` 与正文里的斜杠都不该被当成菜单查询。
 */
export function readSlashQuery(text: string): string | undefined {
  if (!text.startsWith('/')) return undefined
  const query = text.slice(1)
  return /\s/.test(query) ? undefined : query
}

/**
 * 菜单项是否命中当前输入:按名字前缀匹配、忽略大小写。
 * 命令与 skill 共用这一条,所以敲 `/com` 时下拉里只剩 `compact`。
 */
export function matchesSlashQuery(name: string, query: string): boolean {
  return name.toLowerCase().startsWith(query.toLowerCase())
}

/** 决定「这条命令现在能不能用」的那几件事,全部由渲染层手里已有的状态算出来 */
export interface CommandGateState {
  hasConversation: boolean
  hasModel: boolean
  sending: boolean
  compacting: boolean
}

/**
 * 为什么现在不能用这条命令。菜单的 disabled 说明与执行前的守卫共用这一份,
 * 两处各写一遍就会在改文案时漂开。返回 undefined 表示可以用。
 *
 * `compact` 的顺序按「用户最先该知道的那件事」排:没有对话就谈不上压缩,进行中的 run
 * 也不能压,正在压的那一次同样不能再起一次,模型缺了则什么都做不了。
 * `plan` 只在草稿态也允许进入(计划正是从一句需求开始),所以没有「没有对话」这一条。
 */
export function commandBlockedReason(name: string, state: CommandGateState): string | undefined {
  if (name === 'compact') {
    if (!state.hasConversation) return '这条对话还没有内容,没有可压缩的上下文'
    if (state.sending) return '这一轮还在进行中,请等它结束或先点击停止'
    if (state.compacting) return '正在压缩上下文'
    if (!state.hasModel) return '请先在设置中配置模型服务商'
    return undefined
  }
  if (name === 'plan') {
    if (state.sending) return '这一轮还在进行中,请等它结束或先点击停止'
    if (!state.hasModel) return '请先在设置中配置模型服务商'
    return undefined
  }
  return undefined
}
