import type { Message } from '../../src/main/chat/sql'
import type { ToolDefinition } from '../../src/main/tools/types'

let msgSeq = 0

/** 库内消息行;只写关心的字段,其余补成 DB 里的默认空值 */
export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${++msgSeq}`,
    conversation_id: 'conv-1',
    role: 'user',
    content: '',
    reasoning: '',
    tool_calls: [],
    tool_call_id: '',
    run_id: '',
    skill: '',
    agent: '',
    parent_call_id: '',
    depth: 0,
    created_at: '2026-10-08 10:00:00',
    ...overrides
  }
}

/** 只用于回答 isVolatileTool 查询的工具定义,execute 不会被 history 调到 */
export function toolDef(name: string, volatile = false): ToolDefinition {
  return {
    name,
    description: `工具 ${name}`,
    parameters: { type: 'object', properties: {} },
    volatile,
    execute: () => ''
  }
}
