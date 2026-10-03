import { asOptionalString, parseFrontmatter, validateName } from '../shared/frontmatter'

export interface ParsedSkill {
  name: string
  description: string
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  body: string
}

/**
 * 解析并按 Agent Skills 规范校验 SKILL.md。
 * dirName 用于校验 name 与目录名一致;传 undefined 时跳过该项。
 */
export function parseSkillFile(content: string, dirName?: string): ParsedSkill {
  const { data, body } = parseFrontmatter(content)

  const name = validateName(data.name, dirName)

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
