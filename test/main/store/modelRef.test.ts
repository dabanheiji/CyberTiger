import { contextWindowOf, firstRef, normalizeRef } from '../../../src/main/store/modelRef'
import type { ModelConfig, ModelProvider } from '../../../src/main/store/types'

/** 用例大多只关心模型名,所以允许直接传字符串;要测窗口就传完整的 ModelConfig */
function provider(id: string, models: Array<string | ModelConfig>): ModelProvider {
  return {
    id,
    name: id,
    baseUrl: `https://${id}.test/v1`,
    models: models.map((m) => (typeof m === 'string' ? { name: m } : m))
  }
}

const DEEPSEEK = provider('p-deepseek', ['deepseek-chat', 'deepseek-reasoner'])
const OLLAMA = provider('p-ollama', ['qwen3:8b'])
const EMPTY = provider('p-empty', [])

describe('firstRef', () => {
  it('取第一个有模型的服务商的第一个模型', () => {
    expect(firstRef([DEEPSEEK, OLLAMA])).toEqual({
      providerId: 'p-deepseek',
      model: 'deepseek-chat'
    })
  })

  it('跳过模型清单为空的服务商', () => {
    expect(firstRef([EMPTY, OLLAMA])).toEqual({ providerId: 'p-ollama', model: 'qwen3:8b' })
  })

  it('没有任何可用模型时返回 undefined', () => {
    expect(firstRef([])).toBeUndefined()
    expect(firstRef([EMPTY, provider('p-empty2', [])])).toBeUndefined()
  })
})

describe('normalizeRef', () => {
  it('引用仍然有效时原样返回,不丢掉用户的选择', () => {
    const ref = { providerId: 'p-deepseek', model: 'deepseek-reasoner' }
    expect(normalizeRef(ref, [DEEPSEEK, OLLAMA])).toBe(ref)
  })

  it('服务商还在但模型被移出清单时,留在同一家换它的第一个模型', () => {
    expect(normalizeRef({ providerId: 'p-deepseek', model: '已下线的模型' }, [DEEPSEEK])).toEqual({
      providerId: 'p-deepseek',
      model: 'deepseek-chat'
    })
  })

  it('同一家服务商的模型全被清空时,退到别家', () => {
    expect(
      normalizeRef({ providerId: 'p-deepseek', model: 'deepseek-chat' }, [EMPTY, OLLAMA])
    ).toEqual({ providerId: 'p-ollama', model: 'qwen3:8b' })
  })

  it('服务商被删除时退到第一个有模型的服务商', () => {
    expect(normalizeRef({ providerId: '已删除', model: 'x' }, [DEEPSEEK, OLLAMA])).toEqual({
      providerId: 'p-deepseek',
      model: 'deepseek-chat'
    })
  })

  it('引用缺失时同样收敛到第一个可用值', () => {
    expect(normalizeRef(undefined, [OLLAMA])).toEqual({ providerId: 'p-ollama', model: 'qwen3:8b' })
  })

  it('一个服务商都没配时返回 undefined', () => {
    expect(normalizeRef(undefined, [])).toBeUndefined()
    expect(normalizeRef({ providerId: 'x', model: 'y' }, [])).toBeUndefined()
  })

  it('跨服务商的同名模型不会互相误判', () => {
    const shared = [provider('p-a', ['same-model']), provider('p-b', ['other'])]
    expect(normalizeRef({ providerId: 'p-b', model: 'same-model' }, shared)).toEqual({
      providerId: 'p-b',
      model: 'other'
    })
  })
})

describe('contextWindowOf', () => {
  it('取模型自己配置的窗口', () => {
    const p = provider('p-1', [{ name: 'qwen3.5:4b', contextWindow: 262_144 }, 'other'])
    expect(contextWindowOf(p, 'qwen3.5:4b')).toBe(262_144)
  })

  it('没配窗口返回 undefined,由 budgetFor 退回默认值', () => {
    expect(contextWindowOf(provider('p-1', ['m']), 'm')).toBeUndefined()
  })

  it('模型不在候选清单里同样返回 undefined —— 清单不是白名单,手输的模型按默认窗口算', () => {
    expect(
      contextWindowOf(provider('p-1', [{ name: 'a', contextWindow: 8192 }]), 'b')
    ).toBeUndefined()
  })

  it('服务商缺失时返回 undefined 而不是抛错', () => {
    expect(contextWindowOf(undefined, 'm')).toBeUndefined()
  })

  it('同名模型分属两家服务商时各取各的', () => {
    const a = provider('p-a', [{ name: 'same', contextWindow: 32_768 }])
    const b = provider('p-b', [{ name: 'same', contextWindow: 1_048_576 }])
    expect(contextWindowOf(a, 'same')).toBe(32_768)
    expect(contextWindowOf(b, 'same')).toBe(1_048_576)
  })
})
