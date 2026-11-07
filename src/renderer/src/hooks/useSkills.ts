import { useEffect, useRef, useState } from 'react'
import type { SkillMeta } from '../../../main/skills/types'

/**
 * 读取 skill 列表并订阅目录变化;聊天页和设置页共用。
 *
 * - `workspace` 传了就把该项目的 `.cybertiger/skills` 一并带回来(同名由项目覆盖);
 *   设置页不传,只认全局那一层 —— 那两处的启停 / 卸载写的是全局文件。
 * - `sending` 跟随聊天页那一轮 run:开始时与结束时各重拉一次。项目目录没有 watcher,
 *   模型在这一轮里用 `write_file` 新建的 skill 只能靠这次重拉才看得见。
 * - `refreshToken` 由调用方递增来强制重拉(聊天页在敲 `/` 打开面板时用)。
 *
 * `skills:change` 广播里只有全局那一份,所以只能当「有变化」的信号重新拉,
 * 直接 `setSkills(payload)` 会把项目条目冲掉。请求序号挡住先发后到的旧响应。
 */
export function useSkills(workspace = '', sending = false, refreshToken = 0): SkillMeta[] {
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const requestId = useRef(0)

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      const id = ++requestId.current
      window.api.skills.list(workspace || undefined).then((res) => {
        if (cancelled || id !== requestId.current) return
        if (res.success) setSkills(res.data.skills)
      })
    }
    load()
    const unsubscribe = window.api.skills.onChange(() => load())
    return (): void => {
      cancelled = true
      unsubscribe()
    }
  }, [workspace, sending, refreshToken])

  return skills
}
