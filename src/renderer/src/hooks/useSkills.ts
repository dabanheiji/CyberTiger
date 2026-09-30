import { useEffect, useState } from 'react'
import type { SkillMeta } from '../../../main/skills/types'

/** 读取 skill 列表并订阅目录变化;聊天页和设置页共用 */
export function useSkills(): SkillMeta[] {
  const [skills, setSkills] = useState<SkillMeta[]>([])

  useEffect(() => {
    let cancelled = false
    window.api.skills.list().then((res) => {
      if (!cancelled && res.success) setSkills(res.data.skills)
    })
    const unsubscribe = window.api.skills.onChange(setSkills)
    return (): void => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return skills
}
