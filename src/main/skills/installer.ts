import fs from 'fs'
import path from 'path'
import { app, net } from 'electron'
import AdmZip from 'adm-zip'
import { v4 as uuidv4 } from 'uuid'
import { store } from '../store'
import { parseSkillFile } from './parser'
import { skillRegistry, skillsDir, writeSourceRecord, SKILL_FILE, SOURCE_FILE } from './registry'
import type { DiscoverResult, InstallResult, SkillCandidate, SkillSource } from './types'

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
const MAX_DISCOVER_DEPTH = 4
const IGNORED_DIRS = new Set(['node_modules', '.git', '__MACOSX'])

/** discover 解压出来的临时目录,等待 install 或超时清理 */
interface Session {
  root: string
  source: SkillSource
  candidates: SkillCandidate[]
  timer: NodeJS.Timeout
}
const sessions = new Map<string, Session>()
const SESSION_TTL = 10 * 60 * 1000

/** 安装类操作串行执行,避免并发写同一目录 */
let queue: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => undefined)
  return next
}

/** 把用户输入解析为来源;支持 owner/repo[/sub]、GitHub URL(含 tree/ref/sub)、zip 直链 */
export function parseSource(input: string): SkillSource {
  const text = input.trim()
  if (!text) throw new Error('请输入仓库或链接')

  const gh = text.match(
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/tree\/([^/\s]+)(?:\/(.*?))?)?\/?$/
  )
  if (gh) {
    return { type: 'github', repo: `${gh[1]}/${gh[2]}`, ref: gh[3], subpath: gh[4] || undefined }
  }
  if (/^https?:\/\//.test(text)) {
    return { type: 'url', url: text }
  }
  const short = text.match(/^([\w.-]+)\/([\w.-]+)(?:\/(.+))?$/)
  if (short) {
    return { type: 'github', repo: `${short[1]}/${short[2]}`, subpath: short[3] || undefined }
  }
  throw new Error('无法识别的来源,支持 owner/repo、GitHub 链接或 zip 直链')
}

function describeSource(s: SkillSource): string {
  if (s.type === 'github') return `${s.repo}${s.ref ? `@${s.ref}` : ''}${s.subpath ? `/${s.subpath}` : ''}`
  if (s.type === 'url') return s.url
  return '本地'
}

async function download(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
  const res = await net.fetch(url, { headers, redirect: 'follow' })
  if (!res.ok) throw new Error(`下载失败:HTTP ${res.status}`)
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > MAX_ARCHIVE_BYTES) throw new Error('压缩包超过 50 MB 上限')
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength > MAX_ARCHIVE_BYTES) throw new Error('压缩包超过 50 MB 上限')
  return buf
}

/** 取压缩包;GitHub 用 codeload 归档接口,不占 API 配额 */
async function fetchArchive(source: SkillSource): Promise<Buffer> {
  if (source.type === 'url') return download(source.url)
  if (source.type !== 'github') throw new Error('本地来源无需下载')
  const token = store.get('githubToken')
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
  const refs = source.ref ? [source.ref] : ['main', 'master']
  let lastError: Error | null = null
  for (const ref of refs) {
    const url = `https://codeload.github.com/${source.repo}/zip/refs/heads/${ref}`
    try {
      return await download(url, headers)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }
  throw new Error(`无法下载 ${source.repo}:${lastError?.message ?? '未知错误'}`)
}

/** 解压到目标目录;逐条目校验路径,防止 zip-slip */
function extractZip(buffer: Buffer, dest: string): void {
  const zip = new AdmZip(buffer)
  const root = path.resolve(dest)
  for (const entry of zip.getEntries()) {
    const target = path.resolve(root, entry.entryName)
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`压缩包内存在非法路径:${entry.entryName}`)
    }
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true })
      continue
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, entry.getData())
  }
}

/** 递归查找 SKILL.md,每个解析为候选 */
function discoverIn(root: string, subpath?: string): SkillCandidate[] {
  // GitHub 归档外层多一级 "repo-ref/" 目录,先剥掉
  let base = root
  const top = fs.readdirSync(base, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'))
  if (top.length === 1 && top[0].isDirectory() && !fs.existsSync(path.join(base, SKILL_FILE))) {
    base = path.join(base, top[0].name)
  }
  if (subpath) {
    const scoped = path.resolve(base, subpath)
    if (!scoped.startsWith(path.resolve(base))) throw new Error('子路径非法')
    if (!fs.existsSync(scoped)) throw new Error(`仓库中不存在路径 ${subpath}`)
    base = scoped
  }

  const installed = new Set(skillRegistry.list().map((s) => s.name))
  const found: SkillCandidate[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DISCOVER_DEPTH) return
    const skillFile = path.join(dir, SKILL_FILE)
    if (fs.existsSync(skillFile)) {
      const dirName = path.basename(dir)
      const relPath = path.relative(root, dir)
      try {
        const parsed = parseSkillFile(fs.readFileSync(skillFile, 'utf8'), dirName)
        found.push({
          name: parsed.name,
          description: parsed.description,
          relPath,
          bodyPreview: parsed.body.slice(0, 400),
          exists: installed.has(parsed.name)
        })
      } catch (error) {
        found.push({
          name: dirName,
          description: '',
          relPath,
          bodyPreview: '',
          exists: installed.has(dirName),
          error: error instanceof Error ? error.message : String(error)
        })
      }
      return
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        walk(path.join(dir, entry.name), depth + 1)
      }
    }
  }
  walk(base, 0)
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

function newTempDir(): string {
  const dir = path.join(app.getPath('temp'), 'cybertiger-skills', uuidv4())
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function openSession(root: string, source: SkillSource, candidates: SkillCandidate[]): DiscoverResult {
  const sessionId = uuidv4()
  const timer = setTimeout(() => closeSession(sessionId), SESSION_TTL)
  sessions.set(sessionId, { root, source, candidates, timer })
  return { sessionId, source, candidates }
}

function closeSession(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  clearTimeout(s.timer)
  sessions.delete(sessionId)
  fs.rm(s.root, { recursive: true, force: true }, () => undefined)
}

/** 远程来源:下载、解压、发现候选 */
export function discoverRemote(input: string): Promise<DiscoverResult> {
  return discoverFromSource(parseSource(input))
}

function discoverFromSource(source: SkillSource): Promise<DiscoverResult> {
  return serialized(async () => {
    const buffer = await fetchArchive(source)
    const tmp = newTempDir()
    try {
      extractZip(buffer, tmp)
      const candidates = discoverIn(tmp, source.type === 'github' ? source.subpath : undefined)
      if (candidates.length === 0) throw new Error(`${describeSource(source)} 中没有找到 SKILL.md`)
      return openSession(tmp, source, candidates)
    } catch (error) {
      fs.rmSync(tmp, { recursive: true, force: true })
      throw error
    }
  })
}

/** 本地来源:文件夹直接扫描,zip 先解压 */
export function discoverLocal(localPath: string): Promise<DiscoverResult> {
  return serialized(async () => {
    const stat = fs.statSync(localPath)
    const tmp = newTempDir()
    try {
      if (stat.isDirectory()) {
        fs.cpSync(localPath, tmp, { recursive: true })
      } else if (localPath.toLowerCase().endsWith('.zip')) {
        extractZip(fs.readFileSync(localPath), tmp)
      } else {
        throw new Error('请选择文件夹或 zip 文件')
      }
      const candidates = discoverIn(tmp)
      if (candidates.length === 0) throw new Error('没有找到 SKILL.md')
      return openSession(tmp, { type: 'local' }, candidates)
    } catch (error) {
      fs.rmSync(tmp, { recursive: true, force: true })
      throw error
    }
  })
}

/** 把会话里选中的候选复制到 skills 目录 */
export function install(sessionId: string, names: string[], overwrite: boolean): Promise<InstallResult> {
  return serialized(async () => {
    const session = sessions.get(sessionId)
    if (!session) throw new Error('安装会话已过期,请重新获取')
    const dest = skillsDir()
    const installed: string[] = []
    try {
      for (const name of names) {
        const candidate = session.candidates.find((c) => c.name === name)
        if (!candidate) throw new Error(`候选中没有 ${name}`)
        if (candidate.error) throw new Error(`${name} 无法安装:${candidate.error}`)
        const target = path.join(dest, name)
        if (fs.existsSync(target)) {
          if (!overwrite) throw new Error(`skill "${name}" 已存在`)
          fs.rmSync(target, { recursive: true, force: true })
        }
        fs.cpSync(path.join(session.root, candidate.relPath), target, { recursive: true })
        fs.rmSync(path.join(target, SOURCE_FILE), { force: true })
        if (session.source.type !== 'local') writeSourceRecord(target, session.source)
        installed.push(name)
      }
    } finally {
      closeSession(sessionId)
      skillRegistry.refresh()
    }
    return { installed }
  })
}

export function cancelDiscover(sessionId: string): void {
  closeSession(sessionId)
}

export function uninstall(name: string): Promise<void> {
  return serialized(async () => {
    const skill = skillRegistry.get(name)
    if (!skill) throw new Error(`skill "${name}" 不存在`)
    fs.rmSync(skill.dir, { recursive: true, force: true })
    skillRegistry.refresh()
  })
}

/** 按记录的来源重新下载并覆盖 */
export async function update(name: string): Promise<InstallResult> {
  const skill = skillRegistry.get(name)
  if (!skill) throw new Error(`skill "${name}" 不存在`)
  if (skill.source.type === 'local') throw new Error('本地 skill 没有更新来源')
  const result = await discoverFromSource(skill.source)
  const candidate = result.candidates.find((c) => c.name === name)
  if (!candidate) {
    cancelDiscover(result.sessionId)
    throw new Error(`来源中已不存在 skill "${name}"`)
  }
  return install(result.sessionId, [name], true)
}

/** 启动时清理上次残留的临时目录 */
export function cleanupTemp(): void {
  fs.rm(path.join(app.getPath('temp'), 'cybertiger-skills'), { recursive: true, force: true }, () => undefined)
}
