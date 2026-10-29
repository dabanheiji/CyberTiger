import { useEffect, useState } from 'react'
import type { HookRow } from '../../../main/hooks/dto'

/** 设置页要的三份:声明本身 + 钩子目录 + 那份日志的路径 */
export interface HookList {
  hooks: HookRow[]
  dir: string
  logPath: string
}

const EMPTY: HookList = { hooks: [], dir: '', logPath: '' }

/**
 * 读取钩子声明并订阅目录变化。
 *
 * 「最近执行」不在这里:那份记录每次触发都追加一行,是按需拉的表(与 `chat:pendingApprovals`
 * 同一条路),订阅它等于让设置页为一个日志文件长连接。
 */
export function useHooks(): HookList {
  const [list, setList] = useState<HookList>(EMPTY)

  useEffect(() => {
    let cancelled = false
    window.api.hooks.list().then((res) => {
      if (!cancelled && res.success) setList(res.data)
    })
    const unsubscribe = window.api.hooks.onChange((hooks) => {
      setList((prev) => ({ ...prev, hooks }))
    })
    return (): void => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return list
}
