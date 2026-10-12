import { store } from '../../../src/main/store'
import { resolveConnection } from '../../../src/main/store/providers'
import { budgetFor } from '../../../src/main/agent/context'
import type { ModelConfig } from '../../../src/main/store/types'

function setProvider(models: ModelConfig[]): void {
  store.set('providers', [
    { id: 'p-1', name: '本地', baseUrl: 'http://localhost:11434/v1', models }
  ])
}

describe('resolveConnection 解析上下文窗口', () => {
  beforeEach(() => {
    store.clear()
  })

  it('带出所选模型配置的窗口', () => {
    setProvider([{ name: 'qwen3.5:4b', contextWindow: 262_144 }])
    expect(resolveConnection({ providerId: 'p-1', model: 'qwen3.5:4b' }).contextWindow).toBe(
      262_144
    )
  })

  it('模型没配窗口时给 undefined,由 budgetFor 退回默认值', () => {
    setProvider([{ name: 'qwen3:8b' }])
    const { contextWindow } = resolveConnection({ providerId: 'p-1', model: 'qwen3:8b' })
    expect(contextWindow).toBeUndefined()
    expect(budgetFor(contextWindow).window).toBe(budgetFor().window)
  })

  it('模型不在候选清单里也照样连得通 —— 清单不是白名单,只是窗口按默认算', () => {
    setProvider([{ name: 'a', contextWindow: 32_768 }])
    const connection = resolveConnection({ providerId: 'p-1', model: '临时手输的模型' })
    expect(connection.model).toBe('临时手输的模型')
    expect(connection.contextWindow).toBeUndefined()
  })

  it('服务商被删时抛错,而不是带着空地址去请求', () => {
    setProvider([{ name: 'a' }])
    expect(() => resolveConnection({ providerId: '已删除', model: 'a' })).toThrow(/服务商已不存在/)
  })
})
