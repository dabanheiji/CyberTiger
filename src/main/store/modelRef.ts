import type { ModelProvider, ModelRef } from './types'

/**
 * 模型引用与模型配置的纯逻辑,与 electron-store 无关 —— 主进程(删除服务商后收敛、
 * 解析连接)与渲染层(加载设置时校验选择、算上下文占用)共用同一套规则,
 * 避免两边各写一份而慢慢跑偏。
 */

/** 第一个有模型的服务商的第一个模型 */
export function firstRef(providers: ModelProvider[]): ModelRef | undefined {
  for (const provider of providers) {
    if (provider.models.length > 0) {
      return { providerId: provider.id, model: provider.models[0].name }
    }
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
      if (provider.models.some((m) => m.name === ref.model)) return ref
      if (provider.models.length > 0) {
        return { providerId: provider.id, model: provider.models[0].name }
      }
    }
  }
  return firstRef(providers)
}

/**
 * 取某个模型配置的上下文窗口;没配、服务商没了、模型不在候选清单里都返回 undefined,
 * 由调用方(budgetFor)退回默认窗口。
 * 清单只是候选而不是白名单,所以手输的模型名走的是同一条兜底路径。
 */
export function contextWindowOf(
  provider: ModelProvider | undefined,
  model: string
): number | undefined {
  return provider?.models.find((m) => m.name === model)?.contextWindow
}
