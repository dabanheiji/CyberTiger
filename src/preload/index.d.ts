import { ElectronAPI } from '@electron-toolkit/preload'
import router from './router'

export type Router = typeof router

declare global {
  interface Window {
    electron: ElectronAPI
    api: Router
  }
}
