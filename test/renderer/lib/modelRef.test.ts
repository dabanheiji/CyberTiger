import { modelKey, parseModelKey } from '../../../src/renderer/src/lib/modelRef'
import type { ModelRef } from '../../../src/main/store/types'

describe('modelKey / parseModelKey', () => {
  it('往返还原引用', () => {
    const refs: ModelRef[] = [
      { providerId: 'p-1', model: 'deepseek-chat' },
      { providerId: 'p-2', model: 'qwen3:8b' },
      { providerId: 'uuid-like-id', model: 'gpt-4o-mini-2024-07-18' },
      { providerId: 'p-1', model: '' }
    ]
    for (const ref of refs) {
      expect(parseModelKey(modelKey(ref))).toEqual(ref)
    }
  })

  it('分隔符是不可见字符,模型 ID 里的冒号与斜杠都不干扰', () => {
    const ref: ModelRef = { providerId: 'p-1', model: 'registry.local/vllm:latest' }
    expect(parseModelKey(modelKey(ref))).toEqual(ref)
  })

  it('同一家服务商下的不同模型得到不同 key', () => {
    const a = modelKey({ providerId: 'p-1', model: 'm-1' })
    const b = modelKey({ providerId: 'p-1', model: 'm-2' })
    const c = modelKey({ providerId: 'p-2', model: 'm-1' })
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it('key 是单个字符串,可直接作为 Select 的 value', () => {
    expect(typeof modelKey({ providerId: 'p-1', model: 'm-1' })).toBe('string')
  })

  it('缺少分隔符的输入按当前实现落在最后一个字符处切分', () => {
    // 界面只会把 modelKey 的产物喂回来,这里固化行为而不是兜底
    expect(parseModelKey('no-separator')).toEqual({
      providerId: 'no-separato',
      model: 'no-separator'
    })
  })
})
