import { SUB_AGENT_SYSTEM_PROMPT } from '../agent/prompt'
import type { AgentMeta } from './types'

/**
 * 内置通用角色:task 不指定 agent 参数时使用。
 * 它不出现在"可用子 Agent"目录里(那是给可挑选的角色用的),也不能被编辑或删除。
 */
export const GENERIC_AGENT: AgentMeta = {
  name: 'generic',
  description: '通用子 Agent:用当前可用的工具独立完成一项子任务',
  dir: '',
  systemPrompt: SUB_AGENT_SYSTEM_PROMPT,
  builtin: true,
  enabled: true
}

/** 全部内置角色;以后要加内置角色往这里追加即可,设置页与运行时会自动带上 */
export const BUILTIN_AGENTS: AgentMeta[] = [GENERIC_AGENT]

/**
 * 计划模式的角色名。
 *
 * 它不是一个可选的内置角色:计划 run 由聊天服务直接发起、有自己的只读工具池,
 * 所以不进 `BUILTIN_AGENTS`(否则会出现在设置页,也能被 `task` 派发 —— 而子 Agent
 * 的上下文里没有用户,`ask_user` 也就装不进去)。这里只登记名字与步数上限,
 * 并把名字占住,免得用户自定义角色与它撞名后,库里那些计划草稿的归属变得说不清。
 */
export const PLAN_AGENT_NAME = 'plan-agent'

/** 计划 run 的步数上限:读代码 + 提问 + 改写计划,12 步够用,再多就是把时间花在翻文件上 */
export const PLAN_AGENT_MAX_STEPS = 12

/** 内置角色占用的名字,不允许自定义角色使用 */
export const RESERVED_AGENT_NAMES = new Set([...BUILTIN_AGENTS.map((a) => a.name), PLAN_AGENT_NAME])
