import { store } from '../../src/main/store'
import type { AppSettings } from '../../src/main/store/types'

/**
 * `store` 是模块级单例,用例之间会互相串味(上一个用例写的 disabledSkills 会被下一个读到),
 * 所以每个用到 registry / service 的用例都要在 beforeEach 里显式复位。
 */
export function resetSettings(): void {
  store.delete('providers')
  store.delete('currentModel')
  store.delete('mcpServers')
  store.delete('disabledSkills')
  store.delete('disabledAgents')
  store.delete('enableSubAgent')
  store.delete('windowState')
}

export function setSettings(values: AppSettings): void {
  resetSettings()
  if (values.providers) store.set('providers', values.providers)
  if (values.currentModel) store.set('currentModel', values.currentModel)
  if (values.disabledSkills) store.set('disabledSkills', values.disabledSkills)
  if (values.disabledAgents) store.set('disabledAgents', values.disabledAgents)
  if (values.enableSubAgent !== undefined) store.set('enableSubAgent', values.enableSubAgent)
}
