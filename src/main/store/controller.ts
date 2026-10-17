import { AppSettings, store } from './index'
import { applyThemeSource } from '../appearance'
import type { AppearanceSettings } from './types'

export function getAll(_e: any) {
  return store.store
}

export function get(_e: any, key: keyof AppSettings) {
  return store.get(key)
}

export function set(_e: any, key: keyof AppSettings, value: unknown) {
  store.set(key, value)
  // 外观的 mode 由主进程落到 nativeTheme,设了就会触发 updated,窗口底色与顶栏叠层自己跟上。
  // accent 不在这里管:它只改渲染层的令牌,主进程没有对应物。
  if (key === 'appearance') applyThemeSource((value as AppearanceSettings | undefined)?.mode)
}

export function remove(_e: any, key: keyof AppSettings) {
  store.delete(key)
  if (key === 'appearance') applyThemeSource(undefined)
}
