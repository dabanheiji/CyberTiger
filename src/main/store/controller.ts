import { AppSettings, store } from './index'

export function getAll(_e: any) {
  return store.store
}

export function get(_e: any, key: keyof AppSettings) {
  return store.get(key)
}

export function set(_e: any, key: keyof AppSettings, value: unknown) {
  store.set(key, value)
}

export function remove(_e: any, key: keyof AppSettings) {
  store.delete(key)
}
