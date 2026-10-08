import fs from 'node:fs'
import path from 'node:path'
import {
  SKILL_FILE,
  SOURCE_FILE,
  readSourceRecord,
  skillRegistry,
  skillsDir,
  writeSourceRecord
} from '../../../src/main/skills/registry'
import { store } from '../../../src/main/store'
import { resetSettings, setSettings } from '../../helpers/settings'
import {
  makeTempDir,
  releaseCatalog,
  removeTempDir,
  skillDoc,
  useCatalog,
  writeFiles
} from '../../helpers/temp'

const silenced = (): void => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

/** 当前 store 里记的禁用名单 */
const disabledNames = (): string[] => store.get('disabledSkills') ?? []

let root = ''
let outside = ''
let agentsRoot = ''

/** 建一个 skill 目录(不重扫),供逐条断言用 */
function putSkill(name: string, content: string): string {
  writeFiles(root, { [`${name}/${SKILL_FILE}`]: content })
  return path.join(root, name)
}

beforeEach(() => {
  root = makeTempDir()
  outside = makeTempDir()
  agentsRoot = makeTempDir()
  useCatalog(root, agentsRoot)
  resetSettings()
  skillRegistry.scan()
})

afterEach(() => {
  releaseCatalog()
  removeTempDir(root)
  removeTempDir(outside)
  removeTempDir(agentsRoot)
  resetSettings()
})

describe('目录扫描', () => {
  it('按名字排序列出,忽略隐藏目录与非目录条目', () => {
    putSkill('zeta', skillDoc('zeta', 'Z'))
    putSkill('alpha', skillDoc('alpha', 'A'))
    writeFiles(root, { '.hidden/SKILL.md': skillDoc('hidden', 'H'), 'plain.txt': 'x' })
    skillRegistry.scan()
    expect(skillRegistry.list().map((s) => s.name)).toEqual(['alpha', 'zeta'])
  })

  it('解析失败的目录也列出,带 error 且固定禁用', () => {
    putSkill('broken', '没有 frontmatter')
    putSkill('ok', skillDoc('ok', '正常'))
    skillRegistry.scan()
    expect(skillRegistry.get('broken')).toMatchObject({
      description: '',
      enabled: false,
      error: '必须以 YAML frontmatter(---)开头'
    })
    expect(skillRegistry.getEnabled().map((s) => s.name)).toEqual(['ok'])
  })

  it('name 与目录名不一致视为解析失败', () => {
    putSkill('real-dir', skillDoc('other-name', '名字不一致'))
    skillRegistry.scan()
    expect(skillRegistry.get('real-dir')?.error).toContain('必须与目录名')
  })

  it('目录不存在时只记录日志,列出空清单', () => {
    silenced()
    fs.rmSync(root, { recursive: true, force: true })
    skillRegistry.scan()
    expect(skillRegistry.list()).toEqual([])
    expect(console.error).toHaveBeenCalled()
  })

  it('skillsDir 优先取环境变量', () => {
    expect(skillsDir()).toBe(root)
    releaseCatalog()
    // 没有环境变量时退回 userData/skills,由 Electron 决定落点
    expect(skillsDir().endsWith(path.join('userData', 'skills'))).toBe(true)
    useCatalog(root, agentsRoot)
  })
})

describe('启用状态', () => {
  it('setEnabled 写进 store 并在重扫后生效', () => {
    putSkill('alpha', skillDoc('alpha', 'A'))
    skillRegistry.scan()
    expect(skillRegistry.get('alpha')?.enabled).toBe(true)

    skillRegistry.setEnabled('alpha', false)
    expect(disabledNames()).toEqual(['alpha'])
    expect(skillRegistry.get('alpha')?.enabled).toBe(false)

    skillRegistry.setEnabled('alpha', true)
    expect(disabledNames()).toEqual([])
    expect(skillRegistry.get('alpha')?.enabled).toBe(true)
  })

  it('禁用状态跨进程恢复:store 里已有名字时扫描即生效', () => {
    putSkill('alpha', skillDoc('alpha', 'A'))
    setSettings({ disabledSkills: ['alpha'] })
    skillRegistry.scan()
    expect(skillRegistry.get('alpha')?.enabled).toBe(false)
    expect(skillRegistry.getEnabled()).toEqual([])
  })

  it('多个 skill 各自独立启停', () => {
    putSkill('a', skillDoc('a', 'A'))
    putSkill('b', skillDoc('b', 'B'))
    skillRegistry.scan()
    skillRegistry.setEnabled('a', false)
    expect(skillRegistry.getEnabled().map((s) => s.name)).toEqual(['b'])
  })

  it('变更通过 onChange 广播,取消订阅后不再收到', () => {
    const seen: string[][] = []
    const off = skillRegistry.onChange((list) => seen.push(list.map((s) => s.name)))
    putSkill('alpha', skillDoc('alpha', 'A'))
    skillRegistry.setEnabled('alpha', true)
    expect(seen).toEqual([['alpha']])
    off()
    skillRegistry.setEnabled('alpha', false)
    expect(seen).toHaveLength(1)
  })
})

describe('读取正文与文件清单', () => {
  it('readBody 返回去掉 frontmatter 的正文', () => {
    putSkill('alpha', skillDoc('alpha', 'A', '# 步骤\n第一步'))
    skillRegistry.scan()
    expect(skillRegistry.readBody('alpha')).toBe('# 步骤\n第一步')
  })

  it('不存在的 skill 直接抛错', () => {
    expect(() => skillRegistry.readBody('nope')).toThrow('skill "nope" 不存在')
  })

  it('已禁用或解析失败的 skill 都不给正文', () => {
    putSkill('alpha', skillDoc('alpha', 'A'))
    putSkill('broken', '没有 frontmatter')
    skillRegistry.scan()
    skillRegistry.setEnabled('alpha', false)
    expect(() => skillRegistry.readBody('alpha')).toThrow('skill "alpha" 已被禁用')
    expect(() => skillRegistry.readBody('broken')).toThrow(/无法加载/)
  })

  it('listFiles 递归列出相对路径并排序,排除隐藏文件与来源记录', () => {
    putSkill('alpha', skillDoc('alpha', 'A'))
    writeFiles(root, {
      'alpha/references/spec.md': '# spec',
      'alpha/scripts/run.py': 'print(1)',
      'alpha/.DS_Store': 'x'
    })
    writeSourceRecord(path.join(root, 'alpha'), { type: 'local' })
    skillRegistry.scan()
    const files = skillRegistry.listFiles('alpha')
    // 默认字符串序(按码位),大写文件名会排在前面
    expect(files).toEqual([...files].sort())
    expect(files).toEqual(['SKILL.md', 'references/spec.md', 'scripts/run.py'])
    expect(files).not.toContain('.DS_Store')
    expect(files).not.toContain(SOURCE_FILE)
  })

  it('隐藏目录整棵子树都不展开', () => {
    putSkill('alpha', skillDoc('alpha', 'A'))
    writeFiles(root, { 'alpha/.git/config': 'x', 'alpha/visible.md': 'y' })
    skillRegistry.scan()
    expect(skillRegistry.listFiles('alpha')).toEqual(['SKILL.md', 'visible.md'])
  })

  it('listFiles 只到第 5 层,更深的目录不展开', () => {
    putSkill('alpha', skillDoc('alpha', 'A'))
    writeFiles(root, {
      'alpha/a/b/c/d/e/f/deep.md': 'x',
      'alpha/a/b/c/d/e/shallow.md': 'y'
    })
    skillRegistry.scan()
    const files = skillRegistry.listFiles('alpha')
    expect(files).toContain('a/b/c/d/e/shallow.md')
    expect(files).not.toContain('a/b/c/d/e/f/deep.md')
  })
})

describe('readFile 的安全边界', () => {
  beforeEach(() => {
    putSkill('alpha', skillDoc('alpha', 'A'))
    writeFiles(root, {
      'alpha/references/spec.md': '# spec 正文',
      'alpha/notes': '无扩展名也可以读',
      'alpha/logo.png': 'binary-ish'
    })
    skillRegistry.scan()
  })

  it('读取目录内文件', () => {
    expect(skillRegistry.readFile('alpha', 'references/spec.md')).toBe('# spec 正文')
    expect(skillRegistry.readFile('alpha', './references/../references/spec.md')).toBe(
      '# spec 正文'
    )
  })

  it('拒绝 ../ 逃逸', () => {
    writeFiles(outside, { 'secret.md': '机密' })
    expect(() => skillRegistry.readFile('alpha', '../external.md')).toThrow(
      '只能读取该 skill 目录内的文件'
    )
    expect(() => skillRegistry.readFile('alpha', '../../etc/passwd')).toThrow(
      '只能读取该 skill 目录内的文件'
    )
  })

  it('拒绝绝对路径', () => {
    expect(() => skillRegistry.readFile('alpha', path.join(outside, 'secret.md'))).toThrow(
      '只能读取该 skill 目录内的文件'
    )
  })

  it('拒绝符号链接指向目录外的文件', () => {
    writeFiles(outside, { 'secret.md': '机密' })
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'alpha', 'link.md'))
    expect(() => skillRegistry.readFile('alpha', 'link.md')).toThrow(
      '只能读取该 skill 目录内的文件'
    )
  })

  it('文件不存在时给出明确说明', () => {
    expect(() => skillRegistry.readFile('alpha', 'missing.md')).toThrow('文件不存在:missing.md')
  })

  it('目录不是文件', () => {
    expect(() => skillRegistry.readFile('alpha', 'references')).toThrow('references 不是文件')
  })

  it('超过 200 KB 的文件拒绝读取', () => {
    writeFiles(root, { 'alpha/big.md': 'a'.repeat(201 * 1024) })
    skillRegistry.scan()
    expect(() => skillRegistry.readFile('alpha', 'big.md')).toThrow(/文件过大.*上限 200 KB/)
  })

  it('二进制扩展名拒绝,无扩展名放行', () => {
    expect(() => skillRegistry.readFile('alpha', 'logo.png')).toThrow('不支持读取该类型的文件:.png')
    expect(skillRegistry.readFile('alpha', 'notes')).toBe('无扩展名也可以读')
  })

  it('未知或已禁用的 skill 一律先拒绝', () => {
    expect(() => skillRegistry.readFile('nope', 'a.md')).toThrow('skill "nope" 不存在')
    skillRegistry.setEnabled('alpha', false)
    expect(() => skillRegistry.readFile('alpha', 'references/spec.md')).toThrow('已被禁用')
  })
})

describe('安装来源记录', () => {
  it('没有记录文件时按本地来源处理', () => {
    const dir = putSkill('alpha', skillDoc('alpha', 'A'))
    expect(readSourceRecord(dir)).toBeNull()
    skillRegistry.scan()
    expect(skillRegistry.get('alpha')?.source).toEqual({ type: 'local' })
  })

  it('写入后能读回来源与安装时间', () => {
    const dir = putSkill('alpha', skillDoc('alpha', 'A'))
    writeSourceRecord(dir, { type: 'github', repo: 'owner/repo', ref: 'main' })
    expect(readSourceRecord(dir)).toMatchObject({
      source: { type: 'github', repo: 'owner/repo', ref: 'main' }
    })
    skillRegistry.scan()
    expect(skillRegistry.get('alpha')?.source).toMatchObject({ repo: 'owner/repo' })
  })

  it('记录文件损坏或形状不对时退回 null,不影响扫描', () => {
    const dir = putSkill('alpha', skillDoc('alpha', 'A'))
    fs.writeFileSync(path.join(dir, SOURCE_FILE), '{不是 JSON')
    expect(readSourceRecord(dir)).toBeNull()
    fs.writeFileSync(path.join(dir, SOURCE_FILE), '"just a string"')
    expect(readSourceRecord(dir)).toBeNull()
    skillRegistry.scan()
    expect(skillRegistry.get('alpha')?.enabled).toBe(true)
  })

  it('记录文件本身不进 listFiles,也不出现在目录名以 . 开头的条目里', () => {
    const dir = putSkill('alpha', skillDoc('alpha', 'A'))
    writeSourceRecord(dir, { type: 'local' })
    skillRegistry.scan()
    expect(skillRegistry.listFiles('alpha')).not.toContain(SOURCE_FILE)
  })
})
