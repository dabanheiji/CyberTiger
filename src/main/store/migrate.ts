import { v4 as uuidv4 } from 'uuid'
import { store } from './index'
import { normalizeRef } from './modelRef'
import { listProviders } from './providers'
import type { ModelConfig, ModelProvider, ModelRef } from './types'

/** 从 Base URL 里取一个好认的名字(localhost:11434 / api.deepseek.com) */
function providerNameFromUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || '默认服务商'
  } catch {
    return '默认服务商'
  }
}

/** 升级前的服务商:models 是纯字符串数组,窗口还是全局一个值 */
type LegacyProvider = Omit<ModelProvider, 'models'> & { models: Array<string | ModelConfig> }

/**
 * models: string[] → ModelConfig[] 的一次性升级,顺带退役全局 contextWindow。
 *
 * 必须和单服务商迁移分开:那个函数在 providers 已经有内容时直接返回,
 * 而需要升级的恰恰是「已经有内容」的那些配置 —— 挂在它里面就永远跑不到。
 * 幂等靠形状检测:清单里还有字符串元素就说明没迁过,迁完之后再启动不会重复动手。
 */
function migrateModelShapes(): void {
  const legacyWindow = store.get('contextWindow')
  const hasWindow = typeof legacyWindow === 'number'
  const providers = (store.get('providers') ?? []) as unknown as LegacyProvider[]
  // 逐个元素判断而不是只看第一个:半升级的清单(混合形状)也要一起补齐
  const needsShape = providers.some((p) => (p.models ?? []).some((m) => typeof m === 'string'))
  if (!needsShape && !hasWindow) return

  // 全局窗口是给「当时正在用的那个模型」配的,所以只搬给它;其余模型保留自己已有的值
  const current = store.get('currentModel')
  const upgraded: ModelProvider[] = providers.map((p) => ({
    ...p,
    models: (p.models ?? []).map((m): ModelConfig => {
      const name = typeof m === 'string' ? m : m.name
      // 混合形状(有的已升级有的没)也要保住已配好的窗口,不能整份重建成裸的 { name }
      const configured = typeof m === 'string' ? undefined : m.contextWindow
      const carryWindow = hasWindow && p.id === current?.providerId && name === current?.model
      const contextWindow = carryWindow ? legacyWindow : configured
      return contextWindow === undefined ? { name } : { name, contextWindow }
    })
  }))

  store.set('providers', upgraded)
  if (hasWindow) store.delete('contextWindow')
  console.log('[store] 模型清单已升级为逐模型配置上下文窗口(默认 131072)')
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
function migrateSingleProvider(): void {
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
    // 旧键是 string[],搬进来就地换成新形状,免得再走一遍 migrateModelShapes
    models: legacyModels.map((name) => ({ name }))
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

/** 启动时依次跑完所有配置结构迁移;顺序不能反,形状升级依赖最终那份 providers */
export function migrateSettings(): void {
  migrateSingleProvider()
  migrateModelShapes()
}
