import { PLAN_AGENT_SYSTEM_PROMPT } from '../../../src/main/agent/prompt'
import {
  planExecutionMessage,
  planRequestMessage,
  planSystemMessage,
  recentContextDigest,
  revisionRequestMessage
} from '../../../src/main/plan/prompt'
import type { Message } from '../../../src/main/chat/sql'
import { PLAN_AGENT_NAME } from '../../../src/main/agents/builtin'

let seq = 0

/** 一条最小可用的消息行;只填这段逻辑真正读的字段 */
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

describe('recentContextDigest:只取最近的目标与结论', () => {
  it('只留 user / assistant 正文,跳过 tool 行', () => {
    const digest = recentContextDigest([
      msg('user', '改一下聊天页'),
      msg('tool', '工具结果会吃光预算'),
      msg('assistant', '好的')
    ])
    expect(digest).toContain('[用户] 改一下聊天页')
    expect(digest).toContain('[助手] 好的')
    expect(digest).not.toContain('工具结果会吃光预算')
  })

  it('跳过 plan-agent 的旧草稿:上一份计划不该当成本次的上下文', () => {
    const digest = recentContextDigest([
      msg('user', '第一版需求'),
      msg('assistant', '## 上一版计划\n旧计划正文', { agent: PLAN_AGENT_NAME }),
      msg('user', '第二版需求')
    ])
    expect(digest).not.toContain('旧计划正文')
    expect(digest).toContain('第二版需求')
  })

  it('从最新往回取,超出条数上限丢最旧的并写明省略了多少', () => {
    const digest = recentContextDigest(
      [msg('user', '一'), msg('assistant', '二'), msg('user', '三')],
      { maxMessages: 2 }
    )
    expect(digest).toContain('(更早的 1 条消息已省略)')
    expect(digest).not.toContain('[用户] 一')
    expect(digest).toContain('二')
    expect(digest).toContain('三')
  })

  it('单条超长只留前一段并标注截断', () => {
    const digest = recentContextDigest([msg('user', '甲'.repeat(50))], { perMessage: 10 })
    expect(digest).toContain('甲'.repeat(10))
    expect(digest).toContain('该条消息较长,此处已截断')
    expect(digest).not.toContain('甲'.repeat(11))
  })

  it('最新那条即使自己就超预算也留着:丢掉它就等于答非所问', () => {
    const digest = recentContextDigest(
      [msg('user', '旧消息', { content: '旧'.repeat(30) }), msg('user', '新消息'.repeat(10))],
      { maxChars: 5 }
    )
    expect(digest).toContain('新消息')
    expect(digest).not.toContain('旧消息')
  })

  it('没有可用正文时返回空串(请求里那一节直接不出现)', () => {
    expect(recentContextDigest([])).toBe('')
    expect(recentContextDigest([msg('tool', '只有工具结果')])).toBe('')
    expect(recentContextDigest([msg('user', '   ')])).toBe('')
  })
})

describe('请求消息的形状', () => {
  it('首次规划 = 最近上下文 + 本次需求', () => {
    const text = String(
      planRequestMessage('## 最近的对话上下文\n[用户] 前文', '把输入区改宽').content
    )
    expect(text).toContain('## 最近的对话上下文')
    expect(text).toContain('## 本次需求\n把输入区改宽')
  })

  it('摘要为空时只发需求,不留一节空标题', () => {
    const text = String(planRequestMessage('', '把输入区改宽').content)
    expect(text.startsWith('## 本次需求')).toBe(true)
  })

  it('修订 = 摘要 + 需求 + 上一版计划 + 修改意见', () => {
    const text = String(revisionRequestMessage('摘要', '需求', '# 上一版', '第二步太粗').content)
    expect(text).toContain('## 本次需求\n需求')
    expect(text).toContain('## 上一版计划\n# 上一版')
    expect(text).toContain('## 用户的修改意见\n第二步太粗')
  })
})

describe('planExecutionMessage:批准后交给主 Agent 的那一条', () => {
  const text = planExecutionMessage({
    planPath: '/ws/.cybertiger/plans/20261108-100000-x.md',
    taskPath: '/ws/.cybertiger/tasks/20261108-100000-x/task.md',
    plan: '# 计划\n\n第一步'
  })

  it('标出计划执行,并给出两个落盘路径', () => {
    expect(text.startsWith('[计划执行]')).toBe(true)
    expect(text).toContain('/ws/.cybertiger/plans/20261108-100000-x.md')
    expect(text).toContain('/ws/.cybertiger/tasks/20261108-100000-x/task.md')
  })

  it('计划正文整份带上,执行者不必再读文件', () => {
    expect(text).toContain('## 计划正文')
    expect(text).toContain('第一步')
  })

  it('写清执行协议:先拆任务、每步勾选、不新增计划外工作', () => {
    expect(text).toContain('先调用 plan_tasks')
    expect(text).toContain('用 done 勾掉对应序号')
    expect(text).toContain('不新增计划外的工作')
    expect(text).toContain('不要用 write_file')
  })
})

describe('planSystemMessage:计划 run 的 system 前缀', () => {
  it('以计划角色的系统提示词开头', () => {
    expect(String(planSystemMessage('').content).startsWith(PLAN_AGENT_SYSTEM_PROMPT)).toBe(true)
  })

  it('工作空间那一节跟着出现,说明相对路径的基准', () => {
    const text = String(planSystemMessage('/ws/demo').content)
    expect(text).toContain('## 本次会话的工作空间')
    expect(text).toContain('目录:/ws/demo')
  })

  it('没有 skill 时也写明 0 个:整节消失会让模型以为没有这层能力', () => {
    expect(String(planSystemMessage('').content)).toContain('可用 Skills:0 个')
  })

  it('不带子 Agent 目录与「关于你自己的运行环境」:两样都属于主 Agent 那份常量', () => {
    const text = String(planSystemMessage('/ws/demo').content)
    expect(text).not.toContain('## 可用子 Agent')
    expect(text).not.toContain('## 关于你自己的运行环境')
  })
})
