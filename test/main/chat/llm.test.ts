import {
  normalizeDelta,
  normalizeUsage,
  toolsRejected,
  usageRejected
} from '../../../src/main/chat/llm'

describe('normalizeDelta', () => {
  it('只有正文时思考为空字符串', () => {
    expect(normalizeDelta({ content: '你好' })).toEqual({ content: '你好', reasoning: '' })
  })

  it('字段全缺时两者都是空字符串', () => {
    expect(normalizeDelta({})).toEqual({ content: '', reasoning: '' })
    expect(normalizeDelta({ content: null })).toEqual({ content: '', reasoning: '' })
  })

  it('reasoning_content 优先于 reasoning,同时给不会重复', () => {
    expect(
      normalizeDelta({ reasoning_content: 'DeepSeek 风格', reasoning: 'Ollama 风格' }).reasoning
    ).toBe('DeepSeek 风格')
  })

  it('没有前两种字段时退回 reasoning,再没有才读 reasoning_details', () => {
    expect(normalizeDelta({ reasoning: 'Ollama 风格' }).reasoning).toBe('Ollama 风格')
    expect(
      normalizeDelta({ reasoning_details: [{ text: '第一步' }, { summary: '小结' }] }).reasoning
    ).toBe('第一步小结')
  })

  it('reasoning_details 里的空项按空字符串接上,不产生 undefined', () => {
    const reasoning = normalizeDelta({
      reasoning_details: [{ text: null }, { summary: '有内容' }]
    }).reasoning
    expect(reasoning).toBe('有内容')
  })
})

describe('normalizeUsage', () => {
  it('非对象与 null 都算没报', () => {
    expect(normalizeUsage(undefined)).toBeNull()
    expect(normalizeUsage(null)).toBeNull()
    expect(normalizeUsage('123')).toBeNull()
  })

  it('两个字段都缺时返回 null,而不是全 0 的假用量', () => {
    expect(normalizeUsage({})).toBeNull()
    expect(normalizeUsage({ total_tokens: 10 })).toBeNull()
  })

  it('只报了其中一个也算报到了,缺失项按 0 计', () => {
    expect(normalizeUsage({ prompt_tokens: 100 })).toEqual({ prompt: 100, completion: 0 })
    expect(normalizeUsage({ completion_tokens: 20 })).toEqual({ prompt: 0, completion: 20 })
  })

  it('正常上报时两个计数都取原值', () => {
    expect(normalizeUsage({ prompt_tokens: 1234, completion_tokens: 56 })).toEqual({
      prompt: 1234,
      completion: 56
    })
  })
})

describe('降级重试的判据', () => {
  it('toolsRejected 认得出「不认 tools」的文案', () => {
    expect(toolsRejected("Unexpected value 'tools' in payload")).toBe(true)
    expect(toolsRejected('this model does not support function calling')).toBe(false)
  })

  it('usageRejected 认得出 stream_options / include_usage', () => {
    expect(usageRejected('Unsupported parameter: stream_options')).toBe(true)
    expect(usageRejected('unknown field include_usage')).toBe(true)
    expect(usageRejected('Invalid model name')).toBe(false)
  })
})
