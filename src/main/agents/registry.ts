import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { store } from '../store'
import { BUILTIN_AGENTS, GENERIC_AGENT } from './builtin'
import { buildAgentFile, parseAgentFile } from './parser'
import type { AgentDraft, AgentMeta } from './types'

export const AGENT_FILE = 'AGENT.md'

export function agentsDir(): string {
  return process.env.CYBERTIGER_AGENTS_DIR || path.join(app.getPath('userData'), 'agents')
}

/** 原子写:先落临时文件再改名,避免 fs.watch 读到半截内容导致列表闪成错误态 */
function writeAgentFile(dir: string, content: string): void {
  const target = path.join(dir, AGENT_FILE)
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, target)
}

/**
 * 自定义子 Agent 角色目录的注册表,形态与 SkillRegistry 一致:
 * 启动扫描 + fs.watch 防抖重扫 + 变更广播。
 * 磁盘上的 AGENT.md 是唯一事实来源,设置页只是它的编辑器。
 */
class AgentRegistry {
  private agents: AgentMeta[] = []
  private listeners = new Set<(agents: AgentMeta[]) => void>()
  private watcher: fs.FSWatcher | null = null
  private rescanTimer: NodeJS.Timeout | null = null
  /** 串行化写操作,避免并发新建/改名互相踩踏 */
  private queue: Promise<unknown> = Promise.resolve()

  init(): void {
    fs.mkdirSync(agentsDir(), { recursive: true })
    this.scan()
    this.watch()
  }

  onChange(listener: (agents: AgentMeta[]) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.agents)
  }

  private watch(): void {
    try {
      this.watcher = fs.watch(agentsDir(), { recursive: true }, () => this.scheduleRescan())
      this.watcher.on('error', (error) => console.error('[agents] watch error:', error))
    } catch (error) {
      console.error('[agents] 无法监听目录:', error)
    }
  }

  private scheduleRescan(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null
      this.scan()
      this.notify()
    }, 300)
  }

  /** 重新扫描目录;解析失败的目录也进列表但带 error */
  scan(): void {
    const root = agentsDir()
    const disabled = new Set(store.get('disabledAgents') ?? [])
    const custom: AgentMeta[] = []
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch (error) {
      console.error('[agents] 读取目录失败:', error)
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dir = path.join(root, entry.name)
      try {
        const content = fs.readFileSync(path.join(dir, AGENT_FILE), 'utf8')
        const parsed = parseAgentFile(content, entry.name)
        custom.push({
          name: parsed.name,
          description: parsed.description,
          dir,
          systemPrompt: parsed.systemPrompt,
          provider: parsed.provider,
          model: parsed.model,
          tools: parsed.tools,
          enabled: !disabled.has(parsed.name)
        })
      } catch (error) {
        custom.push({
          name: entry.name,
          description: '',
          dir,
          systemPrompt: '',
          enabled: false,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    custom.sort((a, b) => a.name.localeCompare(b.name))
    this.agents = [...BUILTIN_AGENTS, ...custom]
  }

  /** 内置 + 自定义,供设置页展示 */
  list(): AgentMeta[] {
    return this.agents
  }

  /** 只取启用中的自定义角色,供 system prompt 注入目录 */
  getEnabledCustom(): AgentMeta[] {
    return this.agents.filter((a) => !a.builtin && a.enabled && !a.error)
  }

  get(name: string): AgentMeta | undefined {
    return this.agents.find((a) => a.name === name)
  }

  /** 解析 task 工具的 agent 参数;空串表示内置通用角色 */
  resolve(name: string): AgentMeta | undefined {
    return name === '' ? GENERIC_AGENT : this.get(name)
  }

  /** 重扫目录并广播;create / update / remove 等直接改动目录的路径必须走这里 */
  refresh(): void {
    this.scan()
    this.notify()
  }

  setEnabled(name: string, enabled: boolean): void {
    const agent = this.requireCustom(name)
    const disabled = new Set(store.get('disabledAgents') ?? [])
    if (enabled) disabled.delete(agent.name)
    else disabled.add(agent.name)
    store.set('disabledAgents', [...disabled])
    this.refresh()
  }

  create(draft: AgentDraft): Promise<void> {
    return this.serialize(() => {
      const { name, content } = buildAgentFile(draft)
      const dir = path.join(agentsDir(), name)
      if (fs.existsSync(dir)) throw new Error(`角色 "${name}" 已存在`)
      fs.mkdirSync(dir, { recursive: true })
      writeAgentFile(dir, content)
      this.refresh()
    })
  }

  update(previousName: string, draft: AgentDraft): Promise<void> {
    return this.serialize(() => {
      const target = this.requireCustom(previousName)
      const { name, content } = buildAgentFile(draft)

      if (name === target.name) {
        writeAgentFile(target.dir, content)
        this.refresh()
        return
      }

      // 改名:先在新目录写完再删旧目录,中途失败也不会两头都丢
      const nextDir = path.join(agentsDir(), name)
      if (fs.existsSync(nextDir)) throw new Error(`角色 "${name}" 已存在`)
      fs.mkdirSync(nextDir, { recursive: true })
      try {
        writeAgentFile(nextDir, content)
      } catch (error) {
        fs.rmSync(nextDir, { recursive: true, force: true })
        throw error
      }
      fs.rmSync(target.dir, { recursive: true, force: true })

      // 启用状态跟着角色走,不因改名而丢失
      const disabled = new Set(store.get('disabledAgents') ?? [])
      if (disabled.delete(target.name)) {
        if (!target.enabled) disabled.add(name)
        store.set('disabledAgents', [...disabled])
      }
      this.refresh()
    })
  }

  remove(name: string): Promise<void> {
    return this.serialize(() => {
      const target = this.requireCustom(name)
      fs.rmSync(target.dir, { recursive: true, force: true })
      const disabled = new Set(store.get('disabledAgents') ?? [])
      if (disabled.delete(target.name)) store.set('disabledAgents', [...disabled])
      this.refresh()
    })
  }

  /** 串行执行写操作;前一个失败不影响后一个 */
  private serialize<T>(fn: () => T): Promise<T> {
    const next = this.queue.then(fn)
    this.queue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private requireCustom(name: string): AgentMeta {
    const agent = this.get(name)
    if (!agent) throw new Error(`角色 "${name}" 不存在`)
    if (agent.builtin) throw new Error(`内置角色 "${agent.name}" 不可修改`)
    return agent
  }
}

export const agentRegistry = new AgentRegistry()
