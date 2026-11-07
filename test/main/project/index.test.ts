import fs from 'node:fs'
import path from 'node:path'
import {
  PROJECT_DIR,
  ensureProjectRoot,
  mergeByName,
  projectAgents,
  projectHooks,
  projectRoot,
  projectSkills,
  readProjectMcp
} from '../../../src/main/project'
import { skillRegistry } from '../../../src/main/skills/registry'
import { agentRegistry } from '../../../src/main/agents/registry'
import { HOOK_FILE, hookRegistry } from '../../../src/main/hooks/registry'
import { store } from '../../../src/main/store'
import { resetSettings } from '../../helpers/settings'
import {
  agentDoc,
  hookDoc,
  makeTempDir,
  releaseCatalog,
  releaseHooksDir,
  removeTempDir,
  skillDoc,
  useCatalog,
  useHooksDir,
  writeFiles
} from '../../helpers/temp'

/**
 * 项目级配置层(`<workspace>/.cybertiger`)的目录规则、合并规则与三处注册表的接线。
 *
 * 这一层是模型可以经 `write_file` 改的那一半,所以两类断言同样承重:
 * 「项目覆盖全局」是用户要的行为,而「项目钩子一律按受限对待」是它的安全边界 ——
 * 后者不靠文档,靠 `projectHooks()` 把声明里的 `sandboxed` 丢掉。
 */

let ws = ''
let globalSkills = ''
let globalAgents = ''
let globalHooks = ''

const projectFile = (rel: string): string => path.join(ws, PROJECT_DIR, rel)

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  ws = makeTempDir()
  globalSkills = makeTempDir()
  globalAgents = makeTempDir()
  globalHooks = makeTempDir()
  useCatalog(globalSkills, globalAgents)
  useHooksDir(globalHooks)
  resetSettings()
  skillRegistry.scan()
  agentRegistry.scan()
  hookRegistry.scan()
})

afterEach(() => {
  vi.restoreAllMocks()
  releaseCatalog()
  releaseHooksDir()
  removeTempDir(ws)
  removeTempDir(globalSkills)
  removeTempDir(globalAgents)
  removeTempDir(globalHooks)
  resetSettings()
})

describe('.cybertiger 脚手架', () => {
  it('只在根上建一个空目录:子目录与配置由用户或模型按需创建', () => {
    expect(ensureProjectRoot(ws)).toBe(true)
    const root = projectFile('')
    expect(fs.statSync(root).isDirectory()).toBe(true)
    // 初始状态就是空的 —— 预先塞 skills / agents / hooks 会让界面上看起来已经配过一层
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('重复选择同一个工作空间是幂等的', () => {
    expect(ensureProjectRoot(ws)).toBe(true)
    writeFiles(ws, { [path.join(PROJECT_DIR, 'mcp.json')]: '{"mcpServers":{}}' })
    expect(ensureProjectRoot(ws)).toBe(true)
    expect(fs.existsSync(projectFile('mcp.json'))).toBe(true)
  })

  it('没选工作空间时没有根,也不该在进程当前目录里造一个', () => {
    expect(projectRoot('')).toBeNull()
    expect(ensureProjectRoot('   ')).toBe(false)
    expect(fs.existsSync(path.join(process.cwd(), PROJECT_DIR))).toBe(false)
  })
})

describe('目录扫描', () => {
  it('项目 skill 按名字排序,隐藏目录与非目录条目不算', () => {
    writeFiles(ws, {
      [path.join(PROJECT_DIR, 'skills/zeta/SKILL.md')]: skillDoc('zeta', 'Z'),
      [path.join(PROJECT_DIR, 'skills/alpha/SKILL.md')]: skillDoc('alpha', 'A'),
      [path.join(PROJECT_DIR, 'skills/.hidden/SKILL.md')]: skillDoc('hidden', 'H'),
      [path.join(PROJECT_DIR, 'skills/note.txt')]: 'x'
    })
    expect(projectSkills(ws).map((s) => s.name)).toEqual(['alpha', 'zeta'])
  })

  it('解析失败的项目 skill 也进列表,带 error 且不启用', () => {
    writeFiles(ws, {
      [path.join(PROJECT_DIR, 'skills/broken/SKILL.md')]: '没有 frontmatter',
      [path.join(PROJECT_DIR, 'skills/ok/SKILL.md')]: skillDoc('ok', '正常')
    })
    const found = projectSkills(ws)
    expect(found.find((s) => s.name === 'broken')).toMatchObject({
      description: '',
      enabled: false
    })
    expect(found.find((s) => s.name === 'broken')?.error).toContain('frontmatter')
    expect(found.find((s) => s.name === 'ok')?.enabled).toBe(true)
  })

  it('项目角色是同一套扫描规则', () => {
    writeFiles(ws, {
      [path.join(PROJECT_DIR, 'agents/reviewer/AGENT.md')]: agentDoc('reviewer', '审查')
    })
    const found = projectAgents(ws)
    expect(found.map((a) => a.name)).toEqual(['reviewer'])
    expect(found[0].systemPrompt).toContain('reviewer')
  })
})

describe('项目钩子一律按受限对待', () => {
  it('声明 sandboxed: false 也不会被放出去', () => {
    // 这个目录可由仓库带来、也可由模型写出来,而钩子不经过审批、以本应用权限执行
    writeFiles(ws, {
      [path.join(PROJECT_DIR, 'hooks/free/HOOK.md')]: hookDoc('free', {
        keys: 'sandboxed: false\n'
      })
    })
    const [hook] = projectHooks(ws)
    expect(hook.name).toBe('free')
    expect(hook.sandboxed).toBe(true)
  })

  it('解析失败的项目钩子同样按受限对待并永久禁用', () => {
    writeFiles(ws, { [path.join(PROJECT_DIR, 'hooks/broken/HOOK.md')]: '没有 frontmatter' })
    const [hook] = projectHooks(ws)
    expect(hook).toMatchObject({ name: 'broken', enabled: false, sandboxed: true })
    expect(hook.error).toContain('frontmatter')
  })
})

describe('项目覆盖全局', () => {
  it('mergeByName:同名取项目那一份,其余按名字排序', () => {
    const merged = mergeByName(
      [
        { name: 'beta', value: 'global-beta' },
        { name: 'shared', value: 'global-shared' }
      ],
      [
        { name: 'shared', value: 'project-shared' },
        { name: 'alpha', value: 'project-alpha' }
      ]
    )
    expect(merged).toEqual([
      { name: 'alpha', value: 'project-alpha' },
      { name: 'beta', value: 'global-beta' },
      { name: 'shared', value: 'project-shared' }
    ])
  })

  it('skill 注册表:同名项目条目覆盖全局,不传工作空间时只有全局', () => {
    writeFiles(globalSkills, { 'shared/SKILL.md': skillDoc('shared', '全局那一份', '全局正文') })
    writeFiles(ws, {
      [path.join(PROJECT_DIR, 'skills/shared/SKILL.md')]: skillDoc(
        'shared',
        '项目那一份',
        '项目正文'
      ),
      [path.join(PROJECT_DIR, 'skills/extra/SKILL.md')]: skillDoc('extra', '只在项目里')
    })
    skillRegistry.scan()

    expect(skillRegistry.getEnabled().map((s) => s.name)).toEqual(['shared'])
    const merged = skillRegistry.getEnabled(ws)
    expect(merged.map((s) => s.name)).toEqual(['extra', 'shared'])
    expect(merged.find((s) => s.name === 'shared')?.description).toBe('项目那一份')
    // 目录要能标出来源:同名覆盖后,眼前这一条到底是全局的还是项目的
    expect(merged.find((s) => s.name === 'shared')?.scope).toBe('project')
    expect(merged.find((s) => s.name === 'extra')?.scope).toBe('project')
    // readBody 也必须走同一份覆盖,否则模型看到目录说项目那份、正文却是全局那份
    expect(skillRegistry.readBody('shared', ws)).toContain('项目正文')
    expect(skillRegistry.readBody('shared')).toContain('全局正文')
  })

  it('list(工作空间):聊天页的 / 面板看得到项目 skill,设置页那份仍是全局', () => {
    writeFiles(globalSkills, { 'shared/SKILL.md': skillDoc('shared', '全局那一份') })
    writeFiles(ws, {
      [path.join(PROJECT_DIR, 'skills/shared/SKILL.md')]: skillDoc('shared', '项目那一份'),
      [path.join(PROJECT_DIR, 'skills/extra/SKILL.md')]: skillDoc('extra', '只在项目里')
    })
    skillRegistry.scan()

    // 不传工作空间:只有全局,且不带 scope 标记(设置页的启停 / 卸载只对那一条有意义)
    expect(skillRegistry.list().map((s) => s.name)).toEqual(['shared'])
    expect(skillRegistry.list()[0].scope).toBeUndefined()

    const merged = skillRegistry.list(ws)
    expect(merged.map((s) => s.name)).toEqual(['extra', 'shared'])
    expect(merged.find((s) => s.name === 'shared')?.description).toBe('项目那一份')
    expect(merged.find((s) => s.name === 'shared')?.scope).toBe('project')
    expect(merged.find((s) => s.name === 'extra')?.scope).toBe('project')
  })

  it('list(工作空间)留下解析失败的项目条目:界面上要能看到「这里有一条坏了」', () => {
    writeFiles(ws, { [path.join(PROJECT_DIR, 'skills/broken/SKILL.md')]: '没有 frontmatter' })

    const broken = skillRegistry.list(ws).find((s) => s.name === 'broken')
    expect(broken).toMatchObject({ scope: 'project', enabled: false, error: expect.any(String) })
  })

  it('agent 注册表:task 的 resolve 在工作空间里取到项目那份', () => {
    writeFiles(globalAgents, { 'reviewer/AGENT.md': agentDoc('reviewer', '全局') })
    writeFiles(ws, {
      [path.join(PROJECT_DIR, 'agents/reviewer/AGENT.md')]: agentDoc('reviewer', '项目')
    })
    agentRegistry.scan()

    expect(agentRegistry.resolve('reviewer')?.description).toBe('全局')
    expect(agentRegistry.resolve('reviewer', ws)?.description).toBe('项目')
  })

  it('hook 注册表:先合并再按事件过滤,同名的项目钩子换了事件也算覆盖', () => {
    writeFiles(globalHooks, {
      'guard/HOOK.md': hookDoc('guard', { event: 'beforeAgent', description: '全局' })
    })
    writeFiles(ws, {
      [path.join(PROJECT_DIR, 'hooks/guard/HOOK.md')]: hookDoc('guard', {
        event: 'beforeToolCall',
        description: '项目',
        keys: 'sandboxed: false\n'
      })
    })
    hookRegistry.scan()

    expect(hookRegistry.getEnabled(undefined, ws)).toHaveLength(1)
    expect(hookRegistry.getEnabled('beforeAgent', ws)).toEqual([])
    const [project] = hookRegistry.getEnabled('beforeToolCall', ws)
    expect(project.description).toBe('项目')
    expect(project.sandboxed).toBe(true)
  })

  it('禁用名单按名字跨作用域生效:关掉一条等于全局与项目那一条都不跑', () => {
    writeFiles(globalSkills, { 'shared/SKILL.md': skillDoc('shared', '全局') })
    writeFiles(ws, {
      [path.join(PROJECT_DIR, 'skills/shared/SKILL.md')]: skillDoc('shared', '项目')
    })
    store.set('disabledSkills', ['shared'])
    skillRegistry.scan()
    expect(skillRegistry.getEnabled(ws)).toEqual([])
  })
})

describe('.cybertiger/mcp.json', () => {
  it('文件不存在是正常状态:这一层可以只有 skills,也可以什么都没有', () => {
    expect(readProjectMcp(ws)).toEqual({ config: null })
  })

  it('合法配置按与设置页同一种格式解析', () => {
    writeFiles(ws, {
      [path.join(PROJECT_DIR, 'mcp.json')]: JSON.stringify({
        mcpServers: { docs: { command: 'npx', args: ['-y', 'docs-mcp'] } }
      })
    })
    const { config, error } = readProjectMcp(ws)
    expect(error).toBeUndefined()
    expect(config?.mcpServers.docs).toEqual({ command: 'npx', args: ['-y', 'docs-mcp'] })
  })

  it('坏配置返回 null 并带一行原因:坏掉的项目文件不该让这一轮起不来', () => {
    writeFiles(ws, { [path.join(PROJECT_DIR, 'mcp.json')]: '{ 这不是 JSON' })
    const { config, error } = readProjectMcp(ws)
    expect(config).toBeNull()
    expect(error).toContain('mcp.json')
    expect(error).toContain('JSON')
  })
})

describe('钩子目录身份', () => {
  it('HOOK.md 是目录里唯一的声明文件', () => {
    writeFiles(ws, {
      [path.join(PROJECT_DIR, 'hooks/x/HOOK.md')]: hookDoc('x'),
      [path.join(PROJECT_DIR, 'hooks/x/README.md')]: '给人看的'
    })
    expect(projectHooks(ws).map((h) => h.name)).toEqual(['x'])
    expect(fs.existsSync(path.join(ws, PROJECT_DIR, 'hooks/x', HOOK_FILE))).toBe(true)
  })
})
