import { useEffect, useState } from 'react'
import type { AgentMeta } from '../../../main/agents/types'

/** 读取子 Agent 角色列表并订阅目录变化;聊天页与设置页共用 */
export function useAgents(): AgentMeta[] {
  const [agents, setAgents] = useState<AgentMeta[]>([])

  useEffect(() => {
    let cancelled = false
    window.api.agents.list().then((res) => {
      if (!cancelled && res.success) setAgents(res.data.agents)
    })
    const unsubscribe = window.api.agents.onChange(setAgents)
    return (): void => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return agents
}
