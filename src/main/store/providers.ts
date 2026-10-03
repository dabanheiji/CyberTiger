import { store } from './index'
import { normalizeRef } from './modelRef'
import type { ModelProvider, ModelRef } from './types'

export { firstRef, normalizeRef } from './modelRef'

export function listProviders(): ModelProvider[] {
  return store.get('providers') ?? []
}

export function findProvider(id: string): ModelProvider | undefined {
  return listProviders().find((p) => p.id === id)
}

/** 按名字找服务商;AGENT.md 里用名字引用,因为手写的文件里 uuid 不可读 */
export function findProviderByName(name: string): ModelProvider | undefined {
  return listProviders().find((p) => p.name === name)
}

/**
 * 把当前选中的模型收敛成可用值并写回。
 * 删除服务商 / 改模型清单之后必须调用,否则会留下指向已删服务商的悬空引用。
 */
export function normalizeCurrentRef(): ModelRef | undefined {
  const next = normalizeRef(store.get('currentModel'), listProviders())
  store.set('currentModel', next)
  return next
}

/** 一次模型调用所需的连接信息 */
export interface ResolvedConnection {
  providerName: string
  baseUrl: string
  apiKey?: string
  model: string
}

/**
 * 把模型选择解析成调用参数。
 * 这里**不校验 model 是否在候选清单里** —— 清单只是选择器的候选,服务端支持什么由服务端决定;
 * 只有引用整个失效(服务商被删)或服务商没填地址时才报错,交给用户重新选择。
 */
export function resolveConnection(ref: ModelRef): ResolvedConnection {
  const provider = findProvider(ref.providerId)
  if (!provider) throw new Error('所选模型的服务商已不存在,请重新选择模型')
  if (!provider.baseUrl.trim()) throw new Error(`服务商「${provider.name}」还没有填写 Base URL`)
  return {
    providerName: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: ref.model
  }
}
