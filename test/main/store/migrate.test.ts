import { store } from '../../../src/main/store'
import { migrateSettings } from '../../../src/main/store/migrate'
import type { ModelConfig, ModelProvider, ModelRef } from '../../../src/main/store/types'

/**
 * 迁移前的 store 里 models 可能还是老形状(string[]),类型上没法直接表达,
 * 所以构造数据时按 ModelConfig 断言、运行时留字符串 —— 迁移函数靠形状判断,
 * 不该被测试的类型牵着走。
 */
function legacyProvider(models: Array<string | ModelConfig>, id = 'p-1'): ModelProvider[] {
  return [
    {
      id,
      name: id,
      baseUrl: 'http://localhost:11434/v1',
      models: models as unknown as ModelConfig[]
    }
  ]
}

function readProviders(): ModelProvider[] {
  return store.get('providers') as unknown as ModelProvider[]
}

beforeEach(() => {
  store.clear()
})

describe('migrateSettings：模型清单形状升级', () => {
  it('把 string[] 的候选清单升级成逐模型对象', () => {
    store.set('providers', legacyProvider(['deepseek-chat', 'deepseek-reasoner']))
    migrateSettings()
    expect(readProviders()[0].models).toEqual([
      { name: 'deepseek-chat' },
      { name: 'deepseek-reasoner' }
    ])
  })

  it('全局 contextWindow 搬进当前选中的那个模型,其余留默认值', () => {
    store.set('providers', legacyProvider(['qwen3.5:4b', 'qwen3:8b']))
    store.set('currentModel', { providerId: 'p-1', model: 'qwen3:8b' })
    store.set('contextWindow', 65_536)
    migrateSettings()
    expect(readProviders()[0].models).toEqual([
      { name: 'qwen3.5:4b' },
      { name: 'qwen3:8b', contextWindow: 65_536 }
    ])
    // 旧键必须删干净,否则两套数据并存,排查问题时会被误导
    expect(store.get('contextWindow')).toBeUndefined()
  })

  it('清单里一半升级过一半没升级时,已配好的窗口不被重建丢掉', () => {
    store.set('providers', legacyProvider([{ name: 'a', contextWindow: 32_768 }, 'b']))
    store.set('contextWindow', 65_536)
    store.set('currentModel', { providerId: 'p-1', model: 'b' })
    migrateSettings()
    expect(readProviders()[0].models).toEqual([
      { name: 'a', contextWindow: 32_768 },
      { name: 'b', contextWindow: 65_536 }
    ])
  })

  it('迁过之后再启动不会重复动手(幂等)', () => {
    store.set('providers', legacyProvider([{ name: 'a', contextWindow: 262_144 }, 'b']))
    migrateSettings()
    migrateSettings()
    expect(readProviders()[0].models).toEqual([
      { name: 'a', contextWindow: 262_144 },
      { name: 'b' }
    ])
  })

  it('没有服务商时什么都不写', () => {
    migrateSettings()
    expect(store.get('providers')).toBeUndefined()
  })

  it('模型清单为空的服务商保持为空', () => {
    store.set('providers', legacyProvider([]))
    migrateSettings()
    expect(readProviders()[0].models).toEqual([])
  })
})

describe('migrateSettings：单服务商 → 多服务商', () => {
  it('把平铺的 baseUrl / apiKey / models 收进 providers[0],并删掉旧键', () => {
    store.set('baseUrl', 'http://localhost:11434/v1')
    store.set('apiKey', 'sk-legacy')
    store.set('models', ['qwen3.5:4b'])
    migrateSettings()

    const [provider] = readProviders()
    expect(provider.name).toBe('localhost:11434')
    expect(provider.baseUrl).toBe('http://localhost:11434/v1')
    expect(provider.apiKey).toBe('sk-legacy')
    // 旧配置没有窗口概念,搬进来一律留默认值
    expect(provider.models).toEqual([{ name: 'qwen3.5:4b' }])
    expect(store.get('baseUrl')).toBeUndefined()
    expect(store.get('apiKey')).toBeUndefined()
    expect(store.get('models')).toBeUndefined()
  })

  it('迁出来的 currentModel 指向第一个模型', () => {
    store.set('baseUrl', 'http://localhost:11434/v1')
    store.set('models', ['qwen3.5:4b', 'qwen3:8b'])
    migrateSettings()
    const ref = store.get('currentModel') as ModelRef
    expect(ref.providerId).toBe(readProviders()[0].id)
    expect(ref.model).toBe('qwen3.5:4b')
  })

  it('已经有 providers 时不再搬旧的平铺键,避免盖掉用户后来的配置', () => {
    store.set('providers', legacyProvider(['already']))
    store.set('baseUrl', 'http://stale.test/v1')
    migrateSettings()
    expect(readProviders()[0].models).toEqual([{ name: 'already' }])
    expect(store.get('baseUrl')).toBe('http://stale.test/v1')
  })
})
