import type { ModelProvider, ModelRef } from './types'

/**
 * 模型引用的纯逻辑,与 electron-store 无关 —— 主进程(删除服务商后收敛)与渲染层
 * (加载设置时校验选择)共用同一套规则,避免两边各写一份而慢慢跑偏。
 */

/** 第一个有模型的服务商的第一个模型 */
export function firstRef(providers: ModelProvider[]): ModelRef | undefined {
  for (const provider of providers) {
    if (provider.models.length > 0) return { providerId: provider.id, model: provider.models[0] }
  }
  return undefined
}

/**
 * 把悬空引用收敛成可用值:服务商被删、模型被移出候选清单时都会发生。
 * 引用仍然有效时原样返回,不无谓地丢掉用户的选择;
 * 服务商还在、只是模型没了,就留在同一家换它的第一个模型。
 */
export function normalizeRef(
  ref: ModelRef | undefined,
  providers: ModelProvider[]
): ModelRef | undefined {
  if (ref) {
    const provider = providers.find((p) => p.id === ref.providerId)
    if (provider) {
      if (provider.models.includes(ref.model)) return ref
      if (provider.models.length > 0) {
        return { providerId: provider.id, model: provider.models[0] }
      }
    }
  }
  return firstRef(providers)
}
