import { z } from 'zod'
import type { McpConfig } from './types'

const stringMap = z.record(z.string(), z.string())

const stdioSchema = z
  .object({
    command: z.string().min(1, 'command 不能为空'),
    args: z.array(z.string()).optional(),
    env: stringMap.optional(),
    disabled: z.boolean().optional()
  })
  .strict()

const httpSchema = z
  .object({
    url: z.string().url('url 必须是合法的 URL'),
    headers: stringMap.optional(),
    disabled: z.boolean().optional()
  })
  .strict()

/** server 名会拼进工具名,限制为 OpenAI 函数名允许的字符 */
const serverName = z.string().regex(/^[a-zA-Z0-9_-]+$/, 'server 名只能包含字母、数字、下划线和连字符')

const configSchema = z
  .object({
    mcpServers: z.record(serverName, z.union([stdioSchema, httpSchema]))
  })
  .strict()

/** 解析并校验编辑器里的 JSON 文本;失败抛出带位置的中文错误 */
export function parseMcpConfig(json: string): McpConfig {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (error) {
    throw new Error(`JSON 语法错误:${error instanceof Error ? error.message : String(error)}`)
  }
  const result = configSchema.safeParse(raw)
  if (!result.success) {
    const first = result.error.issues[0]
    const path = first.path.length > 0 ? first.path.join('.') : '根节点'
    throw new Error(`配置无效(${path}):${first.message}`)
  }
  return result.data as McpConfig
}

/** 编辑器展示用的格式化文本 */
export function stringifyMcpConfig(config: McpConfig): string {
  return JSON.stringify(config, null, 2)
}
