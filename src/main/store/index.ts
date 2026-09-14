import ElectronStore from 'electron-store'
import type { AppSettings } from './types'

export type { AppSettings } from './types'

// 兼容 CJS/ESM 打包差异
const Store: ElectronStore = (ElectronStore as any).default || ElectronStore

// @ts-ignore
export const store = new Store<AppSettings>({
  name: 'config',
  defaults: {
    baseUrl: undefined,
    apiKey: undefined,
    models: [],
    currentModel: undefined
  }
})
