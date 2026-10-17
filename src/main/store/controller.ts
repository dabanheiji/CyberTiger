import { AppSettings, store } from './index'
import { applyThemeSource } from '../appearance'
import { engineProbe } from '../sandbox/preflight'
import type { AppearanceSettings, SandboxExecStatus } from './types'

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

/**
 * 受限执行的引擎状态。设置页那一栏挂载时读,`startRun` 那一路走的是同一份 memo。
 *
 * 平台在这里补而不是让 `preflight` 读:那一个是纯结论层,另一个才知道自己跑在哪。
 */
export async function sandboxStatus(): Promise<SandboxExecStatus> {
  const probe = await engineProbe()
  return { platform: process.platform, ...probe }
}
