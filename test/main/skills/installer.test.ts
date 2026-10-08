import fs from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'
import {
  cancelDiscover,
  discoverLocal,
  install,
  parseSource,
  uninstall,
  update
} from '../../../src/main/skills/installer'
import { SKILL_FILE, skillRegistry } from '../../../src/main/skills/registry'
import { resetSettings } from '../../helpers/settings'
import {
  makeTempDir,
  releaseCatalog,
  removeTempDir,
  skillDoc,
  useCatalog,
  writeFiles
} from '../../helpers/temp'

let skillsRoot = ''
let sourceRoot = ''
let agentsRoot = ''

beforeEach(() => {
  skillsRoot = makeTempDir()
  sourceRoot = makeTempDir()
  agentsRoot = makeTempDir()
  useCatalog(skillsRoot, agentsRoot)
  resetSettings()
  skillRegistry.scan()
})

afterEach(() => {
  releaseCatalog()
  removeTempDir(skillsRoot)
  removeTempDir(sourceRoot)
  removeTempDir(agentsRoot)
  resetSettings()
})

/** 在 sourceRoot 下铺一个待安装的 skill 目录 */
function putCandidate(name: string, content: string): string {
  writeFiles(sourceRoot, { [`${name}/${SKILL_FILE}`]: content })
  return path.join(sourceRoot, name)
}

describe('来源解析', () => {
  it('owner/repo 与带子路径的简写', () => {
    expect(parseSource('anthropics/skills')).toEqual({
      type: 'github',
      repo: 'anthropics/skills',
      ref: undefined,
      subpath: undefined
    })
    expect(parseSource('anthropics/skills/pptx')).toMatchObject({ subpath: 'pptx' })
  })

  it('GitHub 链接里的 ref 与子路径', () => {
    expect(parseSource('https://github.com/anthropics/skills')).toMatchObject({
      type: 'github',
      repo: 'anthropics/skills'
    })
    expect(parseSource('https://github.com/a/b/tree/v2/skills/x')).toEqual({
      type: 'github',
      repo: 'a/b',
      ref: 'v2',
      subpath: 'skills/x'
    })
    expect(parseSource('https://github.com/a/b.git')).toMatchObject({ repo: 'a/b' })
  })

  it('非 GitHub 的直链按 zip 来源处理', () => {
    expect(parseSource('https://example.com/skill.zip')).toEqual({
      type: 'url',
      url: 'https://example.com/skill.zip'
    })
  })

  it('空输入与无法识别的输入都拒绝', () => {
    expect(() => parseSource('   ')).toThrow('请输入仓库或链接')
    expect(() => parseSource('不是链接也不是仓库')).toThrow(/无法识别的来源/)
  })
})

describe('本地发现', () => {
  it('递归找到 SKILL.md 并按名字排序给出候选', async () => {
    putCandidate('zeta', skillDoc('zeta', 'Z 技能', '# 步骤\n很长' + 'x'.repeat(500)))
    putCandidate('alpha', skillDoc('alpha', 'A 技能'))
    const result = await discoverLocal(sourceRoot)
    expect(result.source).toEqual({ type: 'local' })
    expect(result.candidates.map((c) => c.name)).toEqual(['alpha', 'zeta'])
    expect(result.candidates[1].description).toBe('Z 技能')
    // 预览只取前 400 字,不把整份指南灌进 IPC
    expect(result.candidates[1].bodyPreview.length).toBe(400)
    expect(result.candidates[0].exists).toBe(false)
    cancelDiscover(result.sessionId)
  })

  it('已安装的同名 skill 标记 exists', async () => {
    putCandidate('alpha', skillDoc('alpha', 'A 技能'))
    writeFiles(skillsRoot, { [`alpha/${SKILL_FILE}`]: skillDoc('alpha', '旧版') })
    skillRegistry.scan()
    const result = await discoverLocal(sourceRoot)
    expect(result.candidates[0].exists).toBe(true)
    cancelDiscover(result.sessionId)
  })

  it('解析失败也进候选,带 error 供界面说明', async () => {
    writeFiles(sourceRoot, { [`broken/${SKILL_FILE}`]: '没有 frontmatter' })
    const result = await discoverLocal(sourceRoot)
    expect(result.candidates[0]).toMatchObject({
      name: 'broken',
      description: '',
      error: '必须以 YAML frontmatter(---)开头'
    })
    cancelDiscover(result.sessionId)
  })

  it('目录里没有任何 SKILL.md 时报可读错误', async () => {
    const empty = makeTempDir()
    await expect(discoverLocal(empty)).rejects.toThrow('没有找到 SKILL.md')
    removeTempDir(empty)
  })

  it('既不是目录也不是 zip 时拒绝', async () => {
    const file = path.join(sourceRoot, 'notes.txt')
    fs.writeFileSync(file, 'x')
    await expect(discoverLocal(file)).rejects.toThrow('请选择文件夹或 zip 文件')
  })

  it('zip 里的 ../ 条目被压缩库归一,不会写到目标目录外', async () => {
    // extractZip 里那道逐条目路径校验是第二层保险:adm-zip 在写入与读出时都已经
    // 把 "../../escape.txt" 归一成 "escape.txt",所以这里能验证的是"逃不出去"这个结果
    const zip = new AdmZip()
    zip.addFile('evil/SKILL.md', Buffer.from(skillDoc('evil', 'E'), 'utf8'))
    zip.addFile('../../escape.txt', Buffer.from('逃逸', 'utf8'))
    const zipPath = path.join(sourceRoot, 'bad.zip')
    fs.writeFileSync(zipPath, zip.toBuffer())
    const result = await discoverLocal(zipPath)
    expect(result.candidates.map((c) => c.name)).toEqual(['evil'])
    expect(fs.existsSync(path.join(sourceRoot, 'escape.txt'))).toBe(false)
    expect(fs.existsSync(path.join(sourceRoot, '..', 'escape.txt'))).toBe(false)
    cancelDiscover(result.sessionId)
  })

  it('正常 zip 也能发现候选并安装', async () => {
    const zip = new AdmZip()
    zip.addFile('outer/pptx/SKILL.md', Buffer.from(skillDoc('pptx', '做 PPT'), 'utf8'))
    const zipPath = path.join(sourceRoot, 'skills.zip')
    fs.writeFileSync(zipPath, zip.toBuffer())
    const result = await discoverLocal(zipPath)
    expect(result.candidates.map((c) => c.name)).toEqual(['pptx'])
    const installedResult = await install(result.sessionId, ['pptx'], false)
    expect(installedResult).toEqual({ installed: ['pptx'] })
    expect(fs.existsSync(path.join(skillsRoot, 'pptx', SKILL_FILE))).toBe(true)
  })
})

describe('安装', () => {
  async function discoverOne(name: string): Promise<string> {
    putCandidate(name, skillDoc(name, `${name} 说明`))
    const result = await discoverLocal(sourceRoot)
    return result.sessionId
  }

  it('将选中项复制进 skills 目录并刷新注册表', async () => {
    putCandidate('alpha', skillDoc('alpha', 'A'))
    putCandidate('beta', skillDoc('beta', 'B'))
    const sessionId = await discoverOneFrom(sourceRoot)
    const res = await install(sessionId, ['alpha'], false)
    expect(res).toEqual({ installed: ['alpha'] })
    expect(fs.existsSync(path.join(skillsRoot, 'alpha', SKILL_FILE))).toBe(true)
    // 只装选中的那个
    expect(fs.existsSync(path.join(skillsRoot, 'beta'))).toBe(false)
    expect(skillRegistry.get('alpha')?.enabled).toBe(true)
    // 本地来源不写来源记录(没有可更新的远端)
    expect(fs.existsSync(path.join(skillsRoot, 'alpha', '.cybertiger.json'))).toBe(false)
  })

  it('重名时默认拒绝,overwrite 才覆盖', async () => {
    const sessionId = await discoverOne('alpha')
    writeFiles(skillsRoot, { [`alpha/${SKILL_FILE}`]: skillDoc('alpha', '旧版') })
    skillRegistry.scan()
    await expect(install(sessionId, ['alpha'], false)).rejects.toThrow('skill "alpha" 已存在')

    const again = await discoverOne('alpha')
    await install(again, ['alpha'], true)
    expect(skillRegistry.get('alpha')?.description).toBe('alpha 说明')
  })

  it('带 error 的候选不允许安装', async () => {
    writeFiles(sourceRoot, { [`broken/${SKILL_FILE}`]: '没有 frontmatter' })
    const result = await discoverLocal(sourceRoot)
    await expect(install(result.sessionId, ['broken'], true)).rejects.toThrow(/无法安装/)
  })

  it('候选里没有的名字被拒绝', async () => {
    const sessionId = await discoverOne('alpha')
    await expect(install(sessionId, ['ghost'], false)).rejects.toThrow('候选中没有 ghost')
  })

  it('会话过期或取消后不能安装', async () => {
    const sessionId = await discoverOne('alpha')
    cancelDiscover(sessionId)
    await expect(install(sessionId, ['alpha'], false)).rejects.toThrow('安装会话已过期,请重新获取')
  })

  it('一次安装多个候选', async () => {
    putCandidate('alpha', skillDoc('alpha', 'A'))
    putCandidate('beta', skillDoc('beta', 'B'))
    const result = await discoverLocal(sourceRoot)
    const res = await install(result.sessionId, ['alpha', 'beta'], false)
    expect(res.installed).toEqual(['alpha', 'beta'])
    expect(skillRegistry.list().map((s) => s.name)).toEqual(['alpha', 'beta'])
  })
})

describe('卸载与更新', () => {
  it('卸载删掉整个目录', async () => {
    const dir = putCandidate('alpha', skillDoc('alpha', 'A'))
    fs.cpSync(dir, path.join(skillsRoot, 'alpha'), { recursive: true })
    skillRegistry.refresh()
    await uninstall('alpha')
    expect(fs.existsSync(path.join(skillsRoot, 'alpha'))).toBe(false)
    expect(skillRegistry.get('alpha')).toBeUndefined()
  })

  it('卸载不存在的 skill 时报错', async () => {
    await expect(uninstall('nope')).rejects.toThrow('skill "nope" 不存在')
  })

  it('本地来源没有更新渠道', async () => {
    const dir = putCandidate('alpha', skillDoc('alpha', 'A'))
    fs.cpSync(dir, path.join(skillsRoot, 'alpha'), { recursive: true })
    skillRegistry.refresh()
    await expect(update('alpha')).rejects.toThrow('本地 skill 没有更新来源')
    await expect(update('ghost')).rejects.toThrow('skill "ghost" 不存在')
  })
})

/** discover 整个目录,返回会话 id */
async function discoverOneFrom(dir: string): Promise<string> {
  const result = await discoverLocal(dir)
  return result.sessionId
}
