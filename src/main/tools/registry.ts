import type OpenAI from 'openai'
import type { ToolContext, ToolDefinition, ToolExecResult } from './types'
import { getCurrentTimeTool } from './time'
import { fileTools } from './files'
import { runCommandTool } from './shell'
import { skillTools } from '../skills/tools'
import { mcpManager } from '../mcp/manager'

export type { ToolContext, ToolDefinition, ToolExecResult } from './types'

/**
 * 内置工具;新增内置工具在这里注册。
 * 声明序就是下发给模型的顺序,它会决定请求前缀 —— 新工具追加在末尾,别插到中间。
 */
export const builtinTools: ToolDefinition[] = [
  getCurrentTimeTool,
  ...skillTools,
  ...fileTools,
  runCommandTool
]

/** 当前全部可用工具:内置 + 已连接的 MCP server 提供的。每次调用实时计算 */
export function getAllTools(): ToolDefinition[] {
  // MCP 部分按名字排序:server 的重连顺序会变,而 tools 排在请求的最前面,
  // 它一变就把整段前缀的提示缓存打掉(见 agent/compact.ts 的前缀稳定纪律)
  const mcp = [...mcpManager.getTools()].sort((a, b) => a.name.localeCompare(b.name))
  return [...builtinTools, ...mcp]
}

/**
 * 当前由 MCP server 提供的工具名。
 *
 * 审批判定要靠它区分「外部代码」那一档:光看名字里有没有 `__` 是把 sanitize 的编码规则
 * 当类型用,而 `getAllTools()` 与它是同一时刻读 `mcpManager`,不会有快照错位。
 */
export function getMcpToolNames(): Set<string> {
  return new Set(mcpManager.getTools().map((t) => t.name))
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

/**
 * 把一次调用的 JSON 参数解成对象,解不出来给 `undefined`。
 *
 * 审批闸门与钩子这两道装饰器都**不为一次解析不了的调用做判定**:那句「参数不是合法的 JSON」
 * 由内层 runner 给更准(它手里才有真正的 schema)。空串算「没有参数」,那是合法形状。
 * 导出而不是各写一份,是因为装饰器会一层套一层(`withHooks(withGate(...))`),
 * 两层的「同一次调用是不是同一份参数」必须严格同值,否则边界判定与审批判定会读着两个对象。
 */
export function parseToolArgs(argumentsJson: string): Record<string, unknown> | undefined {
  const trimmed = argumentsJson.trim()
  if (!trimmed) return {}
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // 交给内层 runner 报错
  }
  return undefined
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
