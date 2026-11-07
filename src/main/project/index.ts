import fs from 'fs'
import path from 'path'
import { parseAgentFile } from '../agents/parser'
import type { AgentMeta } from '../agents/types'
import { parseHookFile } from '../hooks/parser'
import type { HookMeta } from '../hooks/types'
import { parseMcpConfig } from '../mcp/config'
import type { McpConfig } from '../mcp/types'
import { parseSkillFile } from '../skills/parser'
import type { SkillMeta } from '../skills/types'

/**
 * 项目级配置目录:工作空间根目录下的 `.cybertiger`。
 *
 * 布局与全局那一层同形:
 *   .cybertiger/skills/<name>/SKILL.md
 *   .cybertiger/agents/<name>/AGENT.md
 *   .cybertiger/hooks/<name>/HOOK.md
 *   .cybertiger/mcp.json         与设置页里那份同一种格式
 *
 * 这一层只对使用该工作空间的会话生效,同名条目覆盖全局那一份。扫描结果按需现算而
 * 不做常驻监听:项目目录归用户与模型自己改,下一次 `run` 会重新读一遍。
 *
 * 这一层不 import electron / DB,所以目录规则与合并规则能脱离应用跑单测。
 */
export const PROJECT_DIR = '.cybertiger'
export const PROJECT_SKILLS_DIR = 'skills'
export const PROJECT_AGENTS_DIR = 'agents'
export const PROJECT_HOOKS_DIR = 'hooks'
export const PROJECT_MCP_FILE = 'mcp.json'

/** 工作空间的 `.cybertiger` 根;没选工作空间返回 null */
export function projectRoot(workspace: string): string | null {
  const trimmed = workspace.trim()
  if (!trimmed) return null
  return path.join(path.resolve(trimmed), PROJECT_DIR)
}

/**
 * 建出空的 `.cybertiger` 根目录。
 *
 * 只在根上 mkdir:里面的子目录与文件由用户(或模型经文件工具)按需创建,所以初始状态
 * 就是一个空文件夹。失败只记一行日志并返回 false —— 选目录这个动作本身不该因为
 * 只读目录或权限问题被拒掉,配置层缺席时其余功能照常工作。
 */
export function ensureProjectRoot(workspace: string): boolean {
  const root = projectRoot(workspace)
  if (!root) return false
  try {
    fs.mkdirSync(root, { recursive: true })
    return true
  } catch (error) {
    console.error(`[project] 无法创建 ${root}:`, error)
    return false
  }
}

export function projectSubdir(workspace: string, kind: string): string | null {
  const root = projectRoot(workspace)
  return root ? path.join(root, kind) : null
}

/** 同名条目由后者覆盖前者,顺序按名字稳定下来(说明顺序、优先级都依赖它) */
export function mergeByName<T extends { name: string }>(global: T[], project: T[]): T[] {
  const merged = new Map<string, T>()
  for (const item of global) merged.set(item.name, item)
  for (const item of project) merged.set(item.name, item)
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** 目录里只有真目录才算条目:软链目录会让「声明在这里、内容在别处」看不出来 */
function listDirs(root: string): fs.Dirent[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[project] 读取 ${root} 失败:`, error)
    }
    return []
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 项目级 skill;解析失败的目录也进列表(带 error 且 enabled=false) */
export function projectSkills(
  workspace: string,
  disabled: ReadonlySet<unknown> = new Set()
): SkillMeta[] {
  const root = projectSubdir(workspace, PROJECT_SKILLS_DIR)
  if (!root) return []
  const result: SkillMeta[] = []
  for (const entry of listDirs(root)) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = path.join(root, entry.name)
    try {
      const content = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
      const parsed = parseSkillFile(content, entry.name)
      result.push({
        name: parsed.name,
        description: parsed.description,
        dir,
        license: parsed.license,
        compatibility: parsed.compatibility,
        metadata: parsed.metadata,
        source: { type: 'local' },
        enabled: !disabled.has(parsed.name)
      })
    } catch (error) {
      result.push({
        name: entry.name,
        description: '',
        dir,
        source: { type: 'local' },
        enabled: false,
        error: errorText(error)
      })
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/** 项目级子 Agent 角色 */
export function projectAgents(
  workspace: string,
  disabled: ReadonlySet<unknown> = new Set()
): AgentMeta[] {
  const root = projectSubdir(workspace, PROJECT_AGENTS_DIR)
  if (!root) return []
  const result: AgentMeta[] = []
  for (const entry of listDirs(root)) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = path.join(root, entry.name)
    try {
      const content = fs.readFileSync(path.join(dir, 'AGENT.md'), 'utf8')
      const parsed = parseAgentFile(content, entry.name)
      result.push({
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
      result.push({
        name: entry.name,
        description: '',
        dir,
        systemPrompt: '',
        enabled: false,
        error: errorText(error)
      })
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 项目级钩子。
 *
 * `sandboxed` 一律按 true 生效,**不采纳声明里的值**:这个目录里的内容可以由仓库带来、
 * 也可以由模型经 write_file 写出来,而钩子不经过审批、以本应用权限执行 —— 让它默认
 * 全权限等于给「改一个项目文件」配了一条提权通道。声明 `sandboxed: false` 也不会被放出去。
 * 沙箱关着、没选工作空间或这台机器没有对应机制时,`boundary.ts` 会让它不运行。
 */
export function projectHooks(
  workspace: string,
  disabled: ReadonlySet<unknown> = new Set()
): HookMeta[] {
  const root = projectSubdir(workspace, PROJECT_HOOKS_DIR)
  if (!root) return []
  const result: HookMeta[] = []
  for (const entry of listDirs(root)) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = path.join(root, entry.name)
    try {
      const content = fs.readFileSync(path.join(dir, 'HOOK.md'), 'utf8')
      const parsed = parseHookFile(content, dir, entry.name)
      result.push({ ...parsed, sandboxed: true, enabled: !disabled.has(parsed.name) })
    } catch (error) {
      result.push({
        name: entry.name,
        description: '',
        event: 'beforeAgent',
        command: '',
        args: [],
        matcher: [],
        sandboxed: true,
        timeoutMs: 10_000,
        once: false,
        doc: '',
        dir,
        enabled: false,
        error: errorText(error)
      })
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

export interface ProjectMcpResult {
  config: McpConfig | null
  error?: string
}

/**
 * 读 `.cybertiger/mcp.json`。文件不存在是正常状态(返回 null);语法或字段不合法时
 * 也返回 null 并带一句原因,坏掉的项目配置不该让这一轮起不来。
 */
export function readProjectMcp(workspace: string): ProjectMcpResult {
  const root = projectRoot(workspace)
  if (!root) return { config: null }
  const file = path.join(root, PROJECT_MCP_FILE)
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { config: null }
    const msg = errorText(error)
    console.error(`[project] 读取 ${file} 失败:`, msg)
    return { config: null, error: msg }
  }
  try {
    return { config: parseMcpConfig(raw) }
  } catch (error) {
    const msg = `${file}: ${errorText(error)}`
    console.error('[project] MCP 配置无效:', msg)
    return { config: null, error: msg }
  }
}
