import { stringify as stringifyYaml } from 'yaml'
import { asOptionalString, parseFrontmatter, validateName } from '../shared/frontmatter'
import { RESERVED_AGENT_NAMES } from './builtin'
import type { AgentDraft } from './types'

export interface ParsedAgent {
  name: string
  description: string
  systemPrompt: string
  provider?: string
  model?: string
  tools?: string[]
}

function validateDescription(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('缺少 description')
  if (value.length > 1024) throw new Error('description 不能超过 1024 个字符')
  return value.trim()
}

/** 校验角色名:除通用规则外,不允许占用内置角色的名字 */
function validateAgentName(value: unknown, dirName?: string): string {
  const name = validateName(value, dirName)
  if (RESERVED_AGENT_NAMES.has(name)) {
    throw new Error(`"${name}" 是内置角色名,请换一个`)
  }
  return name
}

function validateTools(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('tools 必须是数组')
  const names = value.map((item) => {
    if (typeof item !== 'string') throw new Error('tools 只能包含工具名字符串')
    return item.trim()
  })
  const filtered = names.filter(Boolean)
  return filtered.length > 0 ? filtered : undefined
}

function validateSystemPrompt(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('缺少 system prompt')
  }
  return value.trim()
}

/**
 * 解析并按统一规范校验 AGENT.md。
 * dirName 用于校验 name 与目录名一致;传 undefined 时跳过该项。
 */
export function parseAgentFile(content: string, dirName?: string): ParsedAgent {
  const { data, body } = parseFrontmatter(content)
  return {
    name: validateAgentName(data.name, dirName),
    description: validateDescription(data.description),
    systemPrompt: validateSystemPrompt(body),
    provider: asOptionalString(data.provider, 'provider', 40),
    model: asOptionalString(data.model, 'model', 200),
    tools: validateTools(data.tools)
  }
}

/**
 * 把设置页提交的内容校验一遍并序列化成 AGENT.md。
 * 与 parseAgentFile 共用同一套校验,避免前端放过、后端才报错。
 */
export function buildAgentFile(draft: AgentDraft): { name: string; content: string } {
  const name = validateAgentName(draft.name)
  const description = validateDescription(draft.description)
  const systemPrompt = validateSystemPrompt(draft.systemPrompt)
  const provider = draft.provider?.trim() || undefined
  const model = draft.model?.trim() || undefined
  const tools = validateTools(draft.tools)

  const front: Record<string, unknown> = { name, description }
  // provider 会按名字引用,顺序放在 model 前面便于阅读
  if (provider) front.provider = provider
  if (model) front.model = model
  if (tools) front.tools = tools

  return {
    name,
    content: `---\n${stringifyYaml(front).trimEnd()}\n---\n\n${systemPrompt}\n`
  }
}
