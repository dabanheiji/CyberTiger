import ElectronStore from 'electron-store'

// 兼容 CJS/ESM 打包差异
const Store: ElectronStore = (ElectronStore as any).default || ElectronStore

export interface AppSettings {
  baseUrl?: string
  apiKey?: string
}

// @ts-ignore
export const store = new Store<AppSettings>({
  name: 'config',
  defaults: {
    baseUrl: undefined,
    apiKey: undefined
  }
})
