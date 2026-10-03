import { parse as parseYaml } from 'yaml'

/** skill 名与子 Agent 角色名的合法形式:小写字母 / 数字,用连字符分隔 */
export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * 拆出 frontmatter 与正文。文件必须以 --- 开头。
 * skills 的 SKILL.md 与 agents 的 AGENT.md 共用这一套格式。
 */
export function splitFrontmatter(content: string): { yaml: string; body: string } {
  // \uFEFF 用转义写,避免源码里出现不可见字符
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) throw new Error('必须以 YAML frontmatter(---)开头')
  const end = normalized.indexOf('\n---', 4)
  if (end === -1) throw new Error('frontmatter 缺少结束的 ---')
  return {
    yaml: normalized.slice(4, end),
    body: normalized.slice(end + 4).replace(/^\n/, '')
  }
}

/** 解析 frontmatter 为键值映射,并返回正文 */
export function parseFrontmatter(content: string): {
  data: Record<string, unknown>
  body: string
} {
  const { yaml, body } = splitFrontmatter(content)
  let fm: unknown
  try {
    fm = parseYaml(yaml)
  } catch (error) {
    throw new Error(
      `frontmatter 不是合法的 YAML:${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) {
    throw new Error('frontmatter 必须是键值映射')
  }
  return { data: fm as Record<string, unknown>, body }
}

/** 读一个可选的字符串字段,顺带校验长度上限 */
export function asOptionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`)
  if (value.length > max) throw new Error(`${field} 不能超过 ${max} 个字符`)
  return value
}

/**
 * 校验 name 的通用规则:必填、kebab-case、不超过 64 字符。
 * dirName 传 undefined 时跳过"必须与目录名一致"的校验。
 */
export function validateName(value: unknown, dirName?: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('缺少 name')
  if (value.length > 64) throw new Error('name 不能超过 64 个字符')
  if (!NAME_RE.test(value)) {
    throw new Error('name 只能包含小写字母、数字和连字符,不能以连字符开头/结尾或连续出现')
  }
  if (dirName !== undefined && value !== dirName) {
    throw new Error(`name "${value}" 必须与目录名 "${dirName}" 一致`)
  }
  return value
}
