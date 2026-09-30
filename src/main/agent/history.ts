import type { Message } from '../chat/sql'
import type { ChatCompletionMessage } from '../chat/llm'
import { isVolatileTool } from '../tools/registry'
import { skillRegistry } from '../skills/registry'
import { replaceArguments } from '../skills/parser'
import { SYSTEM_PROMPT } from './prompt'

/** 易变工具的旧结果在回放时替换成这段占位,保留"调用过"的事实但不给可复用的数据 */
export const STALE_RESULT_PLACEHOLDER =
  '[此结果已过期,不可引用。如需该信息请重新调用工具。]'

/** 渐进式加载第一层:只把启用的 skill 的名字和描述放进 system prompt */
function skillsCatalog(): string {
  const skills = skillRegistry.getEnabled()
  if (skills.length === 0) return ''
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`)
  return `\n\n## 可用 Skills\n以下是可按需加载的技能。当用户的任务与某项描述匹配时,先调用 load_skill 获取完整指令再行动。\n${lines.join('\n')}`
}

/** 用户通过 / 触发的 skill:把正文与用户输入合并成本轮的 user 消息 */
function expandUserSkill(m: Message): string {
  if (!m.skill) return m.content
  try {
    const body = skillRegistry.readBody(m.skill)
    return `[Skill: ${m.skill}]\n${replaceArguments(body, m.content)}`
  } catch (error) {
    // skill 已被删除或禁用:退化为普通消息,不中断对话
    console.error(`[skills] 展开 ${m.skill} 失败:`, error)
    return m.content
  }
}

/** 把单条库内消息转成发给模型的协议消息;空占位行返回 null */
export function toChatMessage(m: Message): ChatCompletionMessage | null {
  switch (m.role) {
    case 'user':
      return { role: 'user', content: expandUserSkill(m) }
    case 'system':
      return { role: 'system', content: m.content }
    case 'tool':
      return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content }
    case 'assistant': {
      const hasCalls = m.tool_calls.length > 0
      if (!m.content && !hasCalls) return null
      // 思考过程(reasoning)不回传;OpenAI 协议里 assistant 消息只有 content 与 tool_calls
      return {
        role: 'assistant',
        content: m.content || null,
        ...(hasCalls
          ? {
              tool_calls: m.tool_calls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: c.arguments }
              }))
            }
          : {})
      }
    }
  }
}

/**
 * 由会话历史构建请求消息列表,前置 system prompt(含 skill 目录)。
 * 历史里易变工具(volatile)的结果一律视为过期并替换为占位,
 * 模型想复用也没有数据可用,只能重新调用。本轮新产生的结果由 loop 直接追加,不经过这里。
 */
export function buildHistory(messages: Message[]): ChatCompletionMessage[] {
  const history: ChatCompletionMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT + skillsCatalog() }
  ]
  // tool_call_id → 工具名,用于判断 tool 行对应的是哪个工具
  const callTools = new Map<string, string>()

  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const c of m.tool_calls) callTools.set(c.id, c.name)
    }
    const converted = toChatMessage(m)
    if (!converted) continue
    if (converted.role === 'tool') {
      const toolName = callTools.get(m.tool_call_id)
      if (toolName !== undefined && isVolatileTool(toolName)) {
        history.push({ ...converted, content: STALE_RESULT_PLACEHOLDER })
        continue
      }
    }
    history.push(converted)
  }
  return history
}
