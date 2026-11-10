import { PLAN_AGENT_NAME } from '../../../src/main/agents/builtin'
import { derivePendingPlan, isPlanDraft } from '../../../src/main/plan/pending'
import type { Message } from '../../../src/main/chat/sql'

let seq = 0

function msg(role: Message['role'], content: string, overrides: Partial<Message> = {}): Message {
  seq += 1
  return {
    id: `m${seq}`,
    conversation_id: 'c1',
    role,
    content,
    reasoning: '',
    tool_calls: [],
    tool_call_id: '',
    run_id: 'r1',
    skill: '',
    agent: '',
    parent_call_id: '',
    depth: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    tokens_estimated: 0,
    model: '',
    provider_id: '',
    created_at: '2026-11-08 00:00:00',
    ...overrides
  }
}

/** 一条 plan-agent 的纯正文 assistant 行 */
function planDraft(content: string, createdAt = '2026-11-08 00:00:00'): Message {
  return msg('assistant', content, { agent: PLAN_AGENT_NAME, created_at: createdAt })
}

describe('isPlanDraft:只有纯正文的 assistant 行才是计划', () => {
  it('plan-agent 的纯正文 assistant 行命中', () => {
    expect(isPlanDraft(planDraft('# 计划'))).toBe(true)
  })

  it('规划过程中的 tool_calls 行不是结论', () => {
    const message = planDraft('读文件去了')
    message.tool_calls = [{ id: 'call-1', name: 'read_file', arguments: '{}' }]
    expect(isPlanDraft(message)).toBe(false)
  })

  it('主 Agent 的 assistant 行不算', () => {
    expect(isPlanDraft(msg('assistant', '# 计划'))).toBe(false)
  })

  it('空正文不算:那只是一步还没写出东西的占位', () => {
    expect(isPlanDraft(planDraft('   '))).toBe(false)
  })
})

describe('derivePendingPlan:待审批计划由最后一条 user 行之后的消息派生', () => {
  it('没有 user 行 → null', () => {
    expect(derivePendingPlan([planDraft('# 计划')])).toBeNull()
  })

  it('user 行之后还没有草稿 → null(规划还在路上)', () => {
    expect(derivePendingPlan([msg('user', '需求')])).toBeNull()
  })

  it('user 行 + 一份草稿 → 那一份,revision 为 0', () => {
    const reading = msg('assistant', '读一下代码', { agent: PLAN_AGENT_NAME })
    reading.tool_calls = [{ id: 'call-1', name: 'read_file', arguments: '{}' }]
    const result = derivePendingPlan([msg('user', '需求'), reading, planDraft('# 第一版计划')])
    expect(result?.plan).toBe('# 第一版计划')
    expect(result?.revision).toBe(0)
  })

  it('多份草稿取最后一份,revision 是草稿数减一', () => {
    const result = derivePendingPlan([
      msg('user', '需求'),
      planDraft('# 第一版'),
      planDraft('# 第二版'),
      planDraft('# 第三版')
    ])
    expect(result?.plan).toBe('# 第三版')
    expect(result?.revision).toBe(2)
  })

  it('用户批准后写入的 [计划执行] user 行让旧计划自动失效', () => {
    expect(
      derivePendingPlan([msg('user', '需求'), planDraft('# 计划'), msg('user', '[计划执行]\n...')])
    ).toBeNull()
  })

  it('用户忽略计划直接发下一句也一样失效', () => {
    expect(
      derivePendingPlan([msg('user', '需求'), planDraft('# 计划'), msg('user', '算了做别的')])
    ).toBeNull()
  })

  it('只看最后一条 user 行之后的内容:更早的草稿不算待审批', () => {
    const result = derivePendingPlan([
      msg('user', '旧需求'),
      planDraft('# 旧计划'),
      msg('user', '新需求'),
      planDraft('# 新计划')
    ])
    expect(result?.plan).toBe('# 新计划')
    expect(result?.revision).toBe(0)
  })

  it('主 Agent 的 assistant 行夹在中间不影响判定', () => {
    const result = derivePendingPlan([
      msg('user', '需求'),
      msg('assistant', '我先看看'),
      planDraft('# 计划')
    ])
    expect(result?.plan).toBe('# 计划')
  })

  it('created_at 按 UTC 解析:库里的 CURRENT_TIMESTAMP 不带时区', () => {
    const result = derivePendingPlan([
      msg('user', '需求'),
      planDraft('# 计划', '2026-11-08 12:00:00')
    ])
    expect(result?.createdAt).toBe(Date.parse('2026-11-08T12:00:00Z'))
  })

  it('created_at 解析不出来时退回当前时间,而不是 NaN', () => {
    const before = Date.now()
    const result = derivePendingPlan([msg('user', '需求'), planDraft('# 计划', '不是时间')])
    expect(result?.createdAt).toBeGreaterThanOrEqual(before)
    expect(Number.isNaN(result?.createdAt)).toBe(false)
  })
})
