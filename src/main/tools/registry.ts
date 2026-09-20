import type OpenAI from 'openai'
import type { ToolDefinition, ToolExecResult } from './types'
import { getCurrentTimeTool } from './time'
import { mcpManager } from '../mcp/manager'

export type { ToolDefinition, ToolExecResult } from './types'

/** 内置工具;新增内置工具在这里注册 */
export const builtinTools: ToolDefinition[] = [getCurrentTimeTool]

/** 当前全部可用工具:内置 + 已连接的 MCP server 提供的。每次调用实时计算 */
export function getAllTools(): ToolDefinition[] {
  return [...builtinTools, ...mcpManager.getTools()]
}

function findTool(name: string): ToolDefinition | undefined {
  return getAllTools().find((t) => t.name === name)
}

/** 该工具的结果是否随时间变化;未知工具按不变处理 */
export function isVolatileTool(name: string): boolean {
  return findTool(name)?.volatile === true
}

/** 转成 chat/completions 请求里的 tools 参数 */
export function toChatCompletionTools(): OpenAI.Chat.Completions.ChatCompletionFunctionTool[] {
  return getAllTools().map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
}

/**
 * 执行工具。任何失败(找不到工具、参数不是合法 JSON、执行抛错)都不抛出,
 * 而是以 ok=false 加说明文字返回,交给模型自行纠正。
 */
export async function executeTool(name: string, argumentsJson: string): Promise<ToolExecResult> {
  const tool = findTool(name)
  if (!tool) {
    const names = getAllTools()
      .map((t) => t.name)
      .join(', ')
    return { ok: false, result: `未知工具 "${name}",可用工具:${names}` }
  }

  let args: Record<string, unknown> = {}
  const trimmed = argumentsJson.trim()
  if (trimmed) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>
      } else {
        return { ok: false, result: '参数必须是 JSON 对象' }
      }
    } catch {
      return { ok: false, result: `参数不是合法的 JSON:${trimmed}` }
    }
  }

  try {
    return { ok: true, result: await tool.execute(args) }
  } catch (error) {
    return { ok: false, result: error instanceof Error ? error.message : String(error) }
  }
}
