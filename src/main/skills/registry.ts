import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { store } from '../store'
import { parseSkillFile } from './parser'
import type { SkillMeta, SkillSource } from './types'

export const SKILL_FILE = 'SKILL.md'
/** 安装来源记录文件;手动放入的目录没有它 */
export const SOURCE_FILE = '.cybertiger.json'

/** read_skill_file 允许的最大文件 */
const MAX_FILE_BYTES = 200 * 1024
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv', '.xml', '.html', '.css',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.rb', '.go', '.rs',
  '.java', '.kt', '.sql', '.ini', '.cfg', '.env.example', ''
])

export function skillsDir(): string {
  return process.env.CYBERTIGER_SKILLS_DIR || path.join(app.getPath('userData'), 'skills')
}

interface SourceRecord {
  source: SkillSource
  installedAt: string
}

export function readSourceRecord(dir: string): SourceRecord | null {
  try {
    const raw = fs.readFileSync(path.join(dir, SOURCE_FILE), 'utf8')
    const parsed = JSON.parse(raw) as SourceRecord
    return parsed && typeof parsed === 'object' && parsed.source ? parsed : null
  } catch {
    return null
  }
}

export function writeSourceRecord(dir: string, source: SkillSource): void {
  const record: SourceRecord = { source, installedAt: new Date().toISOString() }
  fs.writeFileSync(path.join(dir, SOURCE_FILE), JSON.stringify(record, null, 2))
}

class SkillRegistry {
  private skills: SkillMeta[] = []
  private listeners = new Set<(skills: SkillMeta[]) => void>()
  private watcher: fs.FSWatcher | null = null
  private rescanTimer: NodeJS.Timeout | null = null

  init(): void {
    fs.mkdirSync(skillsDir(), { recursive: true })
    this.scan()
    this.watch()
  }

  onChange(listener: (skills: SkillMeta[]) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const l of this.listeners) l(this.skills)
  }

  private watch(): void {
    try {
      this.watcher = fs.watch(skillsDir(), { recursive: true }, () => this.scheduleRescan())
      this.watcher.on('error', (error) => console.error('[skills] watch error:', error))
    } catch (error) {
      console.error('[skills] 无法监听目录:', error)
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
    const root = skillsDir()
    const disabled = new Set(store.get('disabledSkills') ?? [])
    const result: SkillMeta[] = []
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch (error) {
      console.error('[skills] 读取目录失败:', error)
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dir = path.join(root, entry.name)
      const source = readSourceRecord(dir)?.source ?? { type: 'local' }
      try {
        const content = fs.readFileSync(path.join(dir, SKILL_FILE), 'utf8')
        const parsed = parseSkillFile(content, entry.name)
        result.push({
          name: parsed.name,
          description: parsed.description,
          dir,
          license: parsed.license,
          compatibility: parsed.compatibility,
          metadata: parsed.metadata,
          source,
          enabled: !disabled.has(parsed.name)
        })
      } catch (error) {
        result.push({
          name: entry.name,
          description: '',
          dir,
          source,
          enabled: false,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    result.sort((a, b) => a.name.localeCompare(b.name))
    this.skills = result
  }

  list(): SkillMeta[] {
    return this.skills
  }

  /** 重扫目录并广播变更;install / uninstall 等直接改动目录的路径必须走这里,不能只 scan() */
  refresh(): void {
    this.scan()
    this.notify()
  }

  getEnabled(): SkillMeta[] {
    return this.skills.filter((s) => s.enabled && !s.error)
  }

  get(name: string): SkillMeta | undefined {
    return this.skills.find((s) => s.name === name)
  }

  setEnabled(name: string, enabled: boolean): void {
    const disabled = new Set(store.get('disabledSkills') ?? [])
    if (enabled) disabled.delete(name)
    else disabled.add(name)
    store.set('disabledSkills', [...disabled])
    this.scan()
    this.notify()
  }

  /** SKILL.md 正文(不含 frontmatter) */
  readBody(name: string): string {
    const skill = this.requireEnabled(name)
    const content = fs.readFileSync(path.join(skill.dir, SKILL_FILE), 'utf8')
    return parseSkillFile(content).body
  }

  /** skill 目录下的文件相对路径列表(排除来源记录文件) */
  listFiles(name: string): string[] {
    const skill = this.requireEnabled(name)
    const files: string[] = []
    const walk = (dir: string, rel: string, depth: number): void => {
      if (depth > 5) return
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === SOURCE_FILE || entry.name.startsWith('.')) continue
        const relPath = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath, depth + 1)
        else if (entry.isFile()) files.push(relPath)
      }
    }
    walk(skill.dir, '', 0)
    return files.sort()
  }

  /** 读取 skill 目录内的文本文件;路径逃逸、符号链接逃逸、超大或二进制文件都拒绝 */
  readFile(name: string, relPath: string): string {
    const skill = this.requireEnabled(name)
    const root = fs.realpathSync(skill.dir)
    const target = path.resolve(root, relPath)
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error('只能读取该 skill 目录内的文件')
    }
    let real: string
    try {
      real = fs.realpathSync(target)
    } catch {
      throw new Error(`文件不存在:${relPath}`)
    }
    if (real !== root && !real.startsWith(root + path.sep)) {
      throw new Error('只能读取该 skill 目录内的文件')
    }
    const stat = fs.statSync(real)
    if (!stat.isFile()) throw new Error(`${relPath} 不是文件`)
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`文件过大(${Math.round(stat.size / 1024)} KB),上限 ${MAX_FILE_BYTES / 1024} KB`)
    }
    if (!TEXT_EXTENSIONS.has(path.extname(real).toLowerCase())) {
      throw new Error(`不支持读取该类型的文件:${path.extname(real) || '(无扩展名)'}`)
    }
    return fs.readFileSync(real, 'utf8')
  }

  private requireEnabled(name: string): SkillMeta {
    const skill = this.get(name)
    if (!skill) throw new Error(`skill "${name}" 不存在`)
    if (skill.error) throw new Error(`skill "${name}" 无法加载:${skill.error}`)
    if (!skill.enabled) throw new Error(`skill "${name}" 已被禁用`)
    return skill
  }
}

export const skillRegistry = new SkillRegistry()
