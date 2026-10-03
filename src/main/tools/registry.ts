import type OpenAI from 'openai'
import type { ToolContext, ToolDefinition, ToolExecResult } from './types'
import { getCurrentTimeTool } from './time'
import { skillTools } from '../skills/tools'
import { mcpManager } from '../mcp/manager'

export type { ToolContext, ToolDefinition, ToolExecResult } from './types'

/** 内置工具;新增内置工具在这里注册 */
export const builtinTools: ToolDefinition[] = [getCurrentTimeTool, ...skillTools]

/** 当前全部可用工具:内置 + 已连接的 MCP server 提供的。每次调用实时计算 */
export function getAllTools(): ToolDefinition[] {
  return [...builtinTools, ...mcpManager.getTools()]
}

/**
 * 一次 run 可用的工具集合。
 * 查找与执行都被限制在构造时给定的 definitions 内,而不是全局注册表 —— 这既是
 * 上下文隔离(子 agent 拿不到 task 等),也是安全边界(模型幻觉出的未授权工具名
 * 会被当作未知工具拒绝,不会直通全局)。
 */
export interface ToolRunner {
  /** 构造时的快照;本次 run 全程以此为准,与发给模型的列表严格一致 */
  definitions: ToolDefinition[]
  toChatCompletionTools: () => OpenAI.Chat.Completions.ChatCompletionFunctionTool[]
  /** 执行工具;任何失败都不抛出,统一转成 ok=false + 说明文字 */
  execute: (name: string, argumentsJson: string, context: ToolContext) => Promise<ToolExecResult>
}

/** 该工具的结果是否随时间变化;未知工具按不变处理 */
export function isVolatileTool(name: string, definitions: ToolDefinition[]): boolean {
  return definitions.find((t) => t.name === name)?.volatile === true
}

/** 转成 chat/completions 请求里的 tools 参数 */
export function toChatCompletionTools(
  definitions: ToolDefinition[]
): OpenAI.Chat.Completions.ChatCompletionFunctionTool[] {
  return definitions.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
}

export function createToolRunner(definitions: ToolDefinition[]): ToolRunner {
  const execute = async (
    name: string,
    argumentsJson: string,
    context: ToolContext
  ): Promise<ToolExecResult> => {
    const tool = definitions.find((t) => t.name === name)
    if (!tool) {
      const names = definitions.map((t) => t.name).join(', ')
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
      return { ok: true, result: await tool.execute(args, context) }
    } catch (error) {
      return { ok: false, result: error instanceof Error ? error.message : String(error) }
    }
  }

  return {
    definitions,
    toChatCompletionTools: (): OpenAI.Chat.Completions.ChatCompletionFunctionTool[] =>
      toChatCompletionTools(definitions),
    execute
  }
}
