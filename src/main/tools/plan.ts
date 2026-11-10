import { classifyCommand, commandSegments } from './risk'
import { runCommandTool } from './shell'
import type { ToolDefinition } from './types'

/**
 * 计划阶段对 `run_command` 的额外收窄。
 *
 * `classifyCommand` 回答的是「这条命令能不能被证明只读」,而它有一条已知的窄缝:
 * `git branch <name>` 与 `git remote add` 会改仓库状态,却被判成低风险(本特性只在
 * 计划模式里补上这一刀,普通 `run_command` 的判定一个字都不改)。计划 run 的职责是
 * 读代码、产出一份计划,任何会改动本机状态的操作都不该在这里发生 —— 所以宁可错杀:
 * 只有明确列出的形态放行,其余给一句陈述式拒绝。
 */
const BRANCH_OPTIONS = new Set(['-a', '-r', '-v', '-vv', '--show-current', '--list'])
const BRANCH_LIST = '--list'

function isOption(token: string): boolean {
  return token.length > 1 && token.startsWith('-')
}

function optionName(token: string): string {
  return token.split('=')[0]
}

/** git 的两种「看起来只读」子命令在这里再判一次;返回拒绝句,null 表示放行 */
function gitRejection(argv: readonly string[]): string | null {
  const sub = argv[1]
  if (sub === 'branch') {
    const rest = argv.slice(2)
    const options = rest.filter(isOption)
    const positionals = rest.filter((token) => !isOption(token))
    for (const option of options) {
      const name = optionName(option)
      if (!BRANCH_OPTIONS.has(name)) {
        return `计划阶段不允许 git branch 带 ${name}:这个选项可能改动仓库状态,规划只需要读取`
      }
    }
    const listMode = options.some((option) => optionName(option) === BRANCH_LIST)
    if (positionals.length > 1 || (positionals.length === 1 && !listMode)) {
      return (
        '计划阶段不允许这样使用 git branch:带一个分支名会创建或移动分支,只读形态是不带参数、' +
        '-a / -r / -v / -vv / --show-current,或 --list 后跟一个匹配模式'
      )
    }
    return null
  }

  if (sub === 'remote') {
    const rest = argv.slice(2)
    if (rest.length === 0) return null
    if (rest.length === 1 && rest[0] === '-v') return null
    const [action, name, ...extra] = rest
    if ((action === 'show' || action === 'get-url') && name && extra.length === 0) return null
    return (
      '计划阶段不允许这样使用 git remote:只读形态是不带参数、-v、show <name> 或 get-url <name>, ' +
      'add / remove / set-url 这类会改动仓库配置'
    )
  }

  return null
}

/**
 * 计划模式下这条命令能不能执行:放行返回 null,否则返回给模型看的一句陈述。
 *
 * 先过通用的只读证明,再补 `classifyCommand` 放过去的那两种 git 形态;
 * 任何一段不满足就整条拒绝(与审批名单「每段都要证明」同一条方向)。
 */
export function readOnlyCommandRejection(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed) return '命令是空的,没有执行'
  const risk = classifyCommand(trimmed)
  if (risk.level !== 'low') {
    const reason = risk.reasons[0] ?? '无法证明它只读'
    return `计划阶段只允许证明得了只读的命令,这条没有执行:${reason}`
  }
  const segments = commandSegments(trimmed)
  if (!segments) return '计划阶段只允许证明得了只读的命令,这条没有执行:命令无法被切分成可判断的分段'
  for (const argv of segments) {
    if (argv[0] !== 'git') continue
    const rejection = gitRejection(argv)
    if (rejection) return rejection
  }
  return null
}

/**
 * 只读版的 `run_command`:同名、同参数、同执行逻辑,只在前面加一道只读证明。
 *
 * 计划 run 按 run 现构造这份定义(不进 `getAllTools`),于是普通会话的 `run_command`
 * 一个字节都没变,而计划 run 的结构上跑不出一条写命令 —— 那比在提示词里写「不要改文件」
 * 可靠得多。
 */
export function createReadOnlyRunCommandTool(): ToolDefinition {
  return {
    ...runCommandTool,
    description:
      '在本机执行一条只读的 shell 命令,用于查看代码、检索符号、读取 git 状态与历史,返回 exit_code、实际 cwd 与输出。' +
      '只有能被证明不改动本机状态的命令才会执行:查看 / 检索 / 统计类命令,以及 git 的 status / log / diff / show / blame / ' +
      'rev-parse / describe / ls-files,git branch 与 git remote 只允许不带参数的只读形态;' +
      '写入、删除、安装、推送、重定向、管道到 shell 等一律拒绝,并说明原因。' +
      '工作目录与输出格式与 run_command 一致:省略 cwd 时用本次会话的工作空间,输出最多保留 16000 字符。' +
      '需要读取文件内容时优先用 read_file,它的结果更适合放进上下文。',
    execute: async (args, context): Promise<string> => {
      const command = String(args.command ?? '').trim()
      if (!command) throw new Error('缺少 command')
      const rejection = readOnlyCommandRejection(command)
      if (rejection) throw new Error(rejection)
      return runCommandTool.execute(args, context)
    }
  }
}
