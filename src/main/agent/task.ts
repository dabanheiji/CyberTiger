import type { ToolContext, ToolDefinition } from '../tools/types'

export const TASK_TOOL_NAME = 'task'

/** 子 agent 的步数上限;比主 agent 的 10 小,避免一次派生吃掉过多预算 */
export const SUB_AGENT_MAX_STEPS = 6

/** 子 agent 回传给主 agent 的结论长度上限(字符) */
export const SUB_AGENT_RESULT_MAX = 8 * 1024

export interface SpawnRequest {
  /** 角色名;'' 表示通用子 agent */
  agent: string
  /** 3-5 词的任务简述,用于界面标题 */
  description: string
  /** 完整、自包含的任务说明 */
  prompt: string
  /** 模型额外指定的工具白名单 */
  tools?: string[]
}

/**
 * 真正跑一次子 agent run 并返回其最终结论。
 * 由 service 层注入,agent 目录不直接依赖落库与事件推送。
 * context 携带本次 task 调用的 id,子 agent 靠它挂到父级调用下。
 */
export type SubAgentSpawner = (req: SpawnRequest, context: ToolContext) => Promise<string>

export interface TaskToolOptions {
  /** 当前可选的子 Agent 角色名;为空时不暴露 agent 参数 */
  agents: string[]
}

/**
 * 派生工具:主 agent 通过它把一项子任务交给独立的子 agent。
 * 每次 run 现构造(需要闭包捕获 spawner),因此不会出现在 builtinTools 里,
 * 子 agent 的工具池也天然不含它 —— 结构上不可能递归派生。
 */
export function createTaskTool(spawn: SubAgentSpawner, options: TaskToolOptions): ToolDefinition {
  const properties: Record<string, unknown> = {
    prompt: {
      type: 'string',
      description: '交给子 Agent 的完整任务说明,必须自包含(背景、目标、期望的输出形式)'
    },
    description: {
      type: 'string',
      description: '这项子任务的简短描述,3-5 个词,用于在界面上标识它'
    },
    tools: {
      type: 'array',
      items: { type: 'string' },
      description: '可选。限制子 Agent 可用的工具名;不填则继承当前可用工具'
    }
  }

  // 没有自定义角色时完全不暴露 agent 参数:模型曾把参数描述里的"通用子 Agent"
  // 当成可选值填进来,导致派生直接失败。有角色时用 enum 把取值钉死在角色名上。
  if (options.agents.length > 0) {
    properties.agent = {
      type: 'string',
      enum: options.agents,
      description: `可选。子 Agent 角色名,只能取以下值之一:${options.agents.join('、')}。不确定就省略本参数,省略即使用通用子 Agent。`
    }
  }

  return {
    name: TASK_TOOL_NAME,
    description:
      '派生一个子 Agent 独立完成一项子任务,并返回它的最终结论。' +
      '子 Agent 看不到你与用户的对话,只能看到你给的 prompt,因此 prompt 必须自带全部背景信息。' +
      '适合:需要多步检索或探索、会产生大量中间过程、与当前对话相对独立的子任务。' +
      '不适合:一句话就能回答的问题,或必须依赖上文才能理解的追问。' +
      '子 Agent 返回的是结论本身,不是它的原始过程。',
    parameters: {
      type: 'object',
      properties,
      required: ['prompt', 'description']
    },
    execute: (args, context) => {
      const prompt = String(args.prompt ?? '').trim()
      const description = String(args.description ?? '').trim()
      if (!prompt) throw new Error('缺少 prompt')
      return spawn(
        {
          agent: String(args.agent ?? '').trim(),
          description: description || '子任务',
          prompt,
          tools: Array.isArray(args.tools) ? args.tools.map((t) => String(t)) : undefined
        },
        context
      )
    }
  }
}
