import { parse as parseYaml } from 'yaml'

export interface ParsedSkill {
  name: string
  description: string
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  body: string
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** 拆出 frontmatter 与正文;文件必须以 --- 开头 */
function splitFrontmatter(content: string): { yaml: string; body: string } {
  const normalized = content.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) throw new Error('SKILL.md 必须以 YAML frontmatter(---)开头')
  const end = normalized.indexOf('\n---', 4)
  if (end === -1) throw new Error('frontmatter 缺少结束的 ---')
  return {
    yaml: normalized.slice(4, end),
    body: normalized.slice(end + 4).replace(/^\n/, '')
  }
}

function asOptionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`)
  if (value.length > max) throw new Error(`${field} 不能超过 ${max} 个字符`)
  return value
}

/**
 * 解析并按 Agent Skills 规范校验 SKILL.md。
 * dirName 用于校验 name 与目录名一致;传 undefined 时跳过该项。
 */
export function parseSkillFile(content: string, dirName?: string): ParsedSkill {
  const { yaml, body } = splitFrontmatter(content)
  let fm: unknown
  try {
    fm = parseYaml(yaml)
  } catch (error) {
    throw new Error(`frontmatter 不是合法的 YAML:${error instanceof Error ? error.message : String(error)}`)
  }
  if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) {
    throw new Error('frontmatter 必须是键值映射')
  }
  const data = fm as Record<string, unknown>

  const name = data.name
  if (typeof name !== 'string' || name.length === 0) throw new Error('缺少 name')
  if (name.length > 64) throw new Error('name 不能超过 64 个字符')
  if (!NAME_RE.test(name)) {
    throw new Error('name 只能包含小写字母、数字和连字符,不能以连字符开头/结尾或连续出现')
  }
  if (dirName !== undefined && name !== dirName) {
    throw new Error(`name "${name}" 必须与目录名 "${dirName}" 一致`)
  }

  const description = data.description
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error('缺少 description')
  }
  if (description.length > 1024) throw new Error('description 不能超过 1024 个字符')

  let metadata: Record<string, string> | undefined
  if (data.metadata !== undefined && data.metadata !== null) {
    if (typeof data.metadata !== 'object' || Array.isArray(data.metadata)) {
      throw new Error('metadata 必须是键值映射')
    }
    metadata = {}
    for (const [k, v] of Object.entries(data.metadata as Record<string, unknown>)) {
      metadata[k] = typeof v === 'string' ? v : String(v)
    }
  }

  return {
    name,
    description: description.trim(),
    license: asOptionalString(data.license, 'license', 500),
    compatibility: asOptionalString(data.compatibility, 'compatibility', 500),
    metadata,
    body: body.trim()
  }
}

/** 用户触发时把参数填入正文;没有 $ARGUMENTS 占位符则追加到末尾 */
export function replaceArguments(body: string, args: string): string {
  const trimmed = args.trim()
  if (body.includes('$ARGUMENTS')) return body.replaceAll('$ARGUMENTS', trimmed)
  return trimmed ? `${body}\n\n用户输入:\n${trimmed}` : body
}
