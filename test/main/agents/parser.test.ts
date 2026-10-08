import { GENERIC_AGENT, RESERVED_AGENT_NAMES } from '../../../src/main/agents/builtin'
import { buildAgentFile, parseAgentFile } from '../../../src/main/agents/parser'
import type { AgentDraft } from '../../../src/main/agents/types'

function agentFile(front: string, body = '你是子 Agent'): string {
  return `---\n${front}\n---\n${body}`
}

const MINIMAL = 'name: code-reviewer\ndescription: 审查代码改动'

const FULL_DRAFT: AgentDraft = {
  name: 'code-reviewer',
  description: '审查代码改动',
  systemPrompt: '你是严格的审查者。\n只看 diff,不改文件。',
  provider: 'DeepSeek',
  model: 'deepseek-chat',
  tools: ['get_current_time', 'load_skill']
}

describe('parseAgentFile', () => {
  it('解析最小合法文件', () => {
    expect(parseAgentFile(agentFile(MINIMAL))).toEqual({
      name: 'code-reviewer',
      description: '审查代码改动',
      systemPrompt: '你是子 Agent',
      provider: undefined,
      model: undefined,
      tools: undefined
    })
  })

  it('正文即 system prompt,两端空白去掉', () => {
    expect(parseAgentFile(agentFile(MINIMAL, '\n\n  提示词  \n')).systemPrompt).toBe('提示词')
  })

  it('没有正文时报错', () => {
    expect(() => parseAgentFile(agentFile(MINIMAL, '   '))).toThrow('缺少 system prompt')
  })

  it('缺 description 报错', () => {
    expect(() => parseAgentFile(agentFile('name: code-reviewer'))).toThrow('缺少 description')
  })

  it('name 必须与目录名一致', () => {
    expect(() => parseAgentFile(agentFile(MINIMAL), 'other')).toThrow('必须与目录名 "other" 一致')
  })

  it('不允许占用内置角色名', () => {
    expect(RESERVED_AGENT_NAMES.has(GENERIC_AGENT.name)).toBe(true)
    expect(() => parseAgentFile(agentFile('name: generic\ndescription: x'), 'generic')).toThrow(
      '"generic" 是内置角色名,请换一个'
    )
  })

  it('provider 与 model 各有长度上限', () => {
    expect(() => parseAgentFile(agentFile(`${MINIMAL}\nprovider: ${'p'.repeat(41)}`))).toThrow(
      'provider 不能超过 40 个字符'
    )
    expect(() => parseAgentFile(agentFile(`${MINIMAL}\nmodel: ${'m'.repeat(201)}`))).toThrow(
      'model 不能超过 200 个字符'
    )
  })

  it('tools 必须是字符串数组', () => {
    expect(() => parseAgentFile(agentFile(`${MINIMAL}\ntools: not-a-list`))).toThrow(
      'tools 必须是数组'
    )
    expect(() => parseAgentFile(agentFile(`${MINIMAL}\ntools:\n  - 3`))).toThrow(
      'tools 只能包含工具名字符串'
    )
  })

  it('空 tools 列表等价于不限制,返回 undefined', () => {
    expect(parseAgentFile(agentFile(`${MINIMAL}\ntools: []`)).tools).toBeUndefined()
    expect(parseAgentFile(agentFile(`${MINIMAL}\ntools:\n  - "  "`)).tools).toBeUndefined()
  })

  it('tools 里每项去掉空白并保留顺序', () => {
    expect(parseAgentFile(agentFile(`${MINIMAL}\ntools:\n  - b \n  - a`)).tools).toEqual(['b', 'a'])
  })
})

describe('buildAgentFile', () => {
  it('按 name / description / provider / model / tools 的顺序序列化', () => {
    const { content } = buildAgentFile(FULL_DRAFT)
    const offsets = ['name:', 'description:', 'provider:', 'model:', 'tools:'].map((key) =>
      content.indexOf(key)
    )
    expect(offsets.every((o) => o >= 0)).toBe(true)
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
  })

  it('省略可选字段时不写出对应的键', () => {
    const { content } = buildAgentFile({
      name: 'code-reviewer',
      description: '审查代码改动',
      systemPrompt: '你是审查者'
    })
    expect(content).not.toMatch(/^(provider|model|tools):/m)
    expect(content).toBe('---\nname: code-reviewer\ndescription: 审查代码改动\n---\n\n你是审查者\n')
  })

  it('空字符串的 provider / model 视为未指定', () => {
    const { content } = buildAgentFile({ ...FULL_DRAFT, provider: '  ', model: '' })
    expect(content).not.toMatch(/^(provider|model):/m)
  })

  it('name 不合法时直接报错,不产出文件内容', () => {
    expect(() => buildAgentFile({ ...FULL_DRAFT, name: 'Code Reviewer' })).toThrow(/name/)
    expect(() => buildAgentFile({ ...FULL_DRAFT, name: '' })).toThrow('缺少 name')
  })

  it('正文末尾补一个换行', () => {
    expect(
      buildAgentFile({ ...FULL_DRAFT, systemPrompt: '无尾换行' }).content.endsWith('无尾换行\n')
    ).toBe(true)
  })
})

describe('AGENT.md 往返一致', () => {
  it('buildAgentFile 的产物能被 parseAgentFile 原样读回', () => {
    const { name, content } = buildAgentFile(FULL_DRAFT)
    expect(parseAgentFile(content, name)).toEqual({
      name: FULL_DRAFT.name,
      description: FULL_DRAFT.description,
      systemPrompt: FULL_DRAFT.systemPrompt,
      provider: FULL_DRAFT.provider,
      model: FULL_DRAFT.model,
      tools: FULL_DRAFT.tools
    })
  })

  it('多行中文提示词与特殊字符都能往返', () => {
    const draft: AgentDraft = {
      name: 'tricky',
      description: '含冒号与井号的描述: #1',
      systemPrompt: '第一行\n  缩进行\n- 列表行\n"引号" 与 : 冒号'
    }
    const built = buildAgentFile(draft)
    expect(parseAgentFile(built.content, built.name).systemPrompt).toBe(draft.systemPrompt)
    expect(parseAgentFile(built.content, built.name).description).toBe(draft.description)
  })
})
