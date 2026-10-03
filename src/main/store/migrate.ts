import { v4 as uuidv4 } from 'uuid'
import { store } from './index'
import { normalizeRef } from './modelRef'
import { listProviders } from './providers'
import type { ModelProvider, ModelRef } from './types'

/** 从 Base URL 里取一个好认的名字(localhost:11434 / api.deepseek.com) */
function providerNameFromUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || '默认服务商'
  } catch {
    return '默认服务商'
  }
}

/**
 * 单服务商 → 多服务商的一次性迁移。
 *
 * 旧配置把 baseUrl / apiKey / models 平铺在 store 顶部,现在要收进 providers[0]。
 * 与 database/sql.ts 一样手写迁移而不用 electron-store 的 migrations:
 * 后者的版本号取自 app version,和"配置结构变了"并不同步。
 *
 * 迁移完成后删掉旧键,避免两套数据并存 —— 否则改了 providers 而旧 baseUrl
 * 还留在文件里,排查问题时会被误导。
 */
export function migrateSettings(): void {
  // providers 已经有值说明迁过了(哪怕是空数组 + 单独判断)
  if (listProviders().length > 0) return

  const baseUrl = store.get('baseUrl')
  const legacyModels = store.get('models') ?? []
  // 从没配过模型服务,没什么可搬的
  if (!baseUrl && legacyModels.length === 0) return

  const provider: ModelProvider = {
    id: uuidv4(),
    name: providerNameFromUrl(baseUrl ?? ''),
    baseUrl: baseUrl ?? '',
    apiKey: store.get('apiKey'),
    models: legacyModels
  }
  store.set('providers', [provider])

  // 旧的 currentModel 是字符串,按候选清单校验后再包成 ModelRef
  const legacyCurrent: unknown = store.get('currentModel')
  const picked =
    typeof legacyCurrent === 'string' && legacyModels.includes(legacyCurrent)
      ? legacyCurrent
      : legacyModels[0]
  const ref: ModelRef | undefined = picked ? { providerId: provider.id, model: picked } : undefined
  store.set('currentModel', normalizeRef(ref, [provider]))

  store.delete('baseUrl')
  store.delete('apiKey')
  store.delete('models')
  console.log(`[store] 已把旧的模型配置迁移为服务商「${provider.name}」`)
}
