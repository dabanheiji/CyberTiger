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

/** 内置角色占用的名字,不允许自定义角色使用 */
export const RESERVED_AGENT_NAMES = new Set(BUILTIN_AGENTS.map((a) => a.name))
