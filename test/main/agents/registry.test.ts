import fs from 'node:fs'
import path from 'node:path'
import { AGENT_FILE, agentRegistry, agentsDir } from '../../../src/main/agents/registry'
import { GENERIC_AGENT } from '../../../src/main/agents/builtin'
import { store } from '../../../src/main/store'
import { SUB_AGENT_SYSTEM_PROMPT } from '../../../src/main/agent/prompt'
import { resetSettings, setSettings } from '../../helpers/settings'
import type { AgentDraft } from '../../../src/main/agents/types'
import {
  agentDoc,
  makeTempDir,
  releaseCatalog,
  removeTempDir,
  useCatalog,
  writeFiles
} from '../../helpers/temp'

const disabledNames = (): string[] => store.get('disabledAgents') ?? []

let root = ''
let skillsRoot = ''

function draft(name: string, overrides: Partial<AgentDraft> = {}): AgentDraft {
  return {
    name,
    description: `${name} 的说明`,
    systemPrompt: `你是 ${name}。`,
    ...overrides
  }
}

beforeEach(() => {
  root = makeTempDir()
  skillsRoot = makeTempDir()
  useCatalog(skillsRoot, root)
  resetSettings()
  agentRegistry.scan()
})

afterEach(() => {
  releaseCatalog()
  removeTempDir(root)
  removeTempDir(skillsRoot)
  resetSettings()
})

describe('目录扫描', () => {
  it('内置角色始终排第一,自定义角色按名字排序', () => {
    writeFiles(root, {
      [`zeta/${AGENT_FILE}`]: agentDoc('zeta', 'Z'),
      [`alpha/${AGENT_FILE}`]: agentDoc('alpha', 'A')
    })
    agentRegistry.scan()
    expect(agentRegistry.list().map((a) => a.name)).toEqual(['generic', 'alpha', 'zeta'])
    expect(agentRegistry.get('generic')).toEqual(GENERIC_AGENT)
  })

  it('解析失败的目录带 error 且固定禁用', () => {
    writeFiles(root, {
      [`broken/${AGENT_FILE}`]: '没有 frontmatter',
      [`ok/${AGENT_FILE}`]: agentDoc('ok', '正常')
    })
    agentRegistry.scan()
    expect(agentRegistry.get('broken')).toMatchObject({
      description: '',
      systemPrompt: '',
      enabled: false,
      error: '必须以 YAML frontmatter(---)开头'
    })
    expect(agentRegistry.getEnabledCustom().map((a) => a.name)).toEqual(['ok'])
  })

  it('占用内置角色名的目录按解析失败处理', () => {
    writeFiles(root, { [`generic/${AGENT_FILE}`]: agentDoc('generic', '撞名') })
    agentRegistry.scan()
    // 内置定义排在前面,get() 拿到的仍是内置角色,自定义的坏目录盖不住它
    expect(agentRegistry.get('generic')?.builtin).toBe(true)
    expect(agentRegistry.get('generic')?.error).toBeUndefined()
    expect(agentRegistry.list().filter((a) => a.name === 'generic')).toHaveLength(2)
    expect(agentRegistry.getEnabledCustom()).toEqual([])
  })

  it('provider / model / tools 可选字段按原样带出', () => {
    writeFiles(root, {
      [`coder/${AGENT_FILE}`]: agentDoc(
        'coder',
        '写代码',
        undefined,
        'model: deepseek-v3\ntools:\n  - get_current_time\n'
      )
    })
    agentRegistry.scan()
    expect(agentRegistry.get('coder')).toMatchObject({
      model: 'deepseek-v3',
      tools: ['get_current_time']
    })
  })

  it('agentsDir 优先取环境变量', () => {
    expect(agentsDir()).toBe(root)
    releaseCatalog()
    expect(agentsDir().endsWith('agents')).toBe(true)
    useCatalog(skillsRoot, root)
  })
})

describe('角色解析', () => {
  it('空名字解析到内置通用角色', () => {
    expect(agentRegistry.resolve('')).toBe(GENERIC_AGENT)
    expect(GENERIC_AGENT.systemPrompt).toBe(SUB_AGENT_SYSTEM_PROMPT)
  })

  it('未知名字解析为 undefined,由 task 工具回退处理', () => {
    expect(agentRegistry.resolve('nope')).toBeUndefined()
  })

  it('禁用中的角色仍能被 get 到,只是不进目录', () => {
    writeFiles(root, { [`researcher/${AGENT_FILE}`]: agentDoc('researcher', '检索') })
    setSettings({ disabledAgents: ['researcher'] })
    agentRegistry.scan()
    expect(agentRegistry.get('researcher')?.enabled).toBe(false)
    expect(agentRegistry.getEnabledCustom()).toEqual([])
  })
})

describe('启停', () => {
  it('setEnabled 写 store 并重扫广播', () => {
    writeFiles(root, { [`researcher/${AGENT_FILE}`]: agentDoc('researcher', '检索') })
    agentRegistry.refresh()
    const seen: boolean[] = []
    agentRegistry.onChange((list) =>
      seen.push(list.find((a) => a.name === 'researcher')?.enabled ?? false)
    )

    agentRegistry.setEnabled('researcher', false)
    expect(disabledNames()).toEqual(['researcher'])
    expect(agentRegistry.get('researcher')?.enabled).toBe(false)
    expect(seen).toEqual([false])

    agentRegistry.setEnabled('researcher', true)
    expect(disabledNames()).toEqual([])
    expect(agentRegistry.get('researcher')?.enabled).toBe(true)
  })

  it('内置角色不可启停', () => {
    expect(() => agentRegistry.setEnabled('generic', false)).toThrow('内置角色 "generic" 不可修改')
    expect(() => agentRegistry.setEnabled('missing', true)).toThrow('角色 "missing" 不存在')
  })
})

describe('新建与编辑', () => {
  it('create 落盘 AGENT.md 并立刻可见', async () => {
    await agentRegistry.create(draft('researcher', { tools: ['get_current_time'] }))
    const dir = path.join(root, 'researcher')
    expect(fs.existsSync(path.join(dir, AGENT_FILE))).toBe(true)
    expect(fs.readFileSync(path.join(dir, AGENT_FILE), 'utf8')).toContain('name: researcher')
    expect(agentRegistry.get('researcher')).toMatchObject({
      description: 'researcher 的说明',
      systemPrompt: '你是 researcher。',
      tools: ['get_current_time'],
      dir
    })
    expect(agentRegistry.get('researcher')?.builtin).toBeUndefined()
  })

  it('重名时拒绝,不覆盖已有角色', async () => {
    await agentRegistry.create(draft('researcher'))
    await expect(agentRegistry.create(draft('researcher'))).rejects.toThrow(
      '角色 "researcher" 已存在'
    )
    expect(fs.readFileSync(path.join(root, 'researcher', AGENT_FILE), 'utf8')).toContain(
      '你是 researcher。'
    )
  })

  it('非法名字在建目录前就被拦下', async () => {
    await expect(agentRegistry.create(draft('Bad Name'))).rejects.toThrow(/只能包含小写字母/)
    expect(fs.existsSync(path.join(root, 'Bad Name'))).toBe(false)
  })

  it('内置角色名作为新建名字同样被拒', async () => {
    await expect(agentRegistry.create(draft('generic'))).rejects.toThrow('是内置角色名')
  })

  it('同名编辑只改写文件,目录不动', async () => {
    await agentRegistry.create(draft('researcher'))
    const dir = path.join(root, 'researcher')
    await agentRegistry.update('researcher', draft('researcher', { description: '改过的说明' }))
    expect(fs.existsSync(dir)).toBe(true)
    expect(agentRegistry.get('researcher')?.description).toBe('改过的说明')
  })

  it('改名时先写新目录再删旧目录', async () => {
    await agentRegistry.create(draft('researcher'))
    await agentRegistry.update('researcher', draft('investigator', { description: '换名' }))
    expect(fs.existsSync(path.join(root, 'researcher'))).toBe(false)
    expect(fs.readFileSync(path.join(root, 'investigator', AGENT_FILE), 'utf8')).toContain('换名')
    expect(agentRegistry.get('researcher')).toBeUndefined()
  })

  it('改名把禁用状态一起带过去', async () => {
    await agentRegistry.create(draft('researcher'))
    agentRegistry.setEnabled('researcher', false)
    await agentRegistry.update('researcher', draft('investigator'))
    expect(disabledNames()).toEqual(['investigator'])
    expect(agentRegistry.get('investigator')?.enabled).toBe(false)
  })

  it('改名撞上已有角色时拒绝,原角色保持可用', async () => {
    await agentRegistry.create(draft('researcher'))
    await agentRegistry.create(draft('investigator'))
    await expect(agentRegistry.update('researcher', draft('investigator'))).rejects.toThrow(
      '角色 "investigator" 已存在'
    )
    expect(agentRegistry.get('researcher')?.enabled).toBe(true)
    expect(fs.existsSync(path.join(root, 'researcher'))).toBe(true)
  })

  it('编辑不存在或内置的角色被拒', async () => {
    await expect(agentRegistry.update('nope', draft('nope'))).rejects.toThrow('角色 "nope" 不存在')
    await expect(agentRegistry.update('generic', draft('x'))).rejects.toThrow('内置角色')
  })

  it('并发新建按顺序执行,不会互相踩踏', async () => {
    await Promise.all([
      agentRegistry.create(draft('alpha')),
      agentRegistry.create(draft('beta')),
      agentRegistry.create(draft('gamma'))
    ])
    expect(agentRegistry.list().map((a) => a.name)).toEqual(['generic', 'alpha', 'beta', 'gamma'])
  })
})

describe('删除', () => {
  it('remove 清掉目录与禁用记录', async () => {
    await agentRegistry.create(draft('researcher'))
    agentRegistry.setEnabled('researcher', false)
    expect(disabledNames()).toEqual(['researcher'])

    await agentRegistry.remove('researcher')
    expect(fs.existsSync(path.join(root, 'researcher'))).toBe(false)
    expect(agentRegistry.get('researcher')).toBeUndefined()
    expect(disabledNames()).toEqual([])
  })

  it('删除不存在的角色或内置角色都会被拒', async () => {
    await expect(agentRegistry.remove('nope')).rejects.toThrow('角色 "nope" 不存在')
    await expect(agentRegistry.remove('generic')).rejects.toThrow('内置角色 "generic" 不可修改')
    // 内置角色的定义仍在
    expect(agentRegistry.get('generic')).toBeDefined()
  })

  it('一次删除失败不影响后续操作', async () => {
    await agentRegistry.create(draft('alpha'))
    await expect(agentRegistry.remove('nope')).rejects.toThrow()
    await agentRegistry.remove('alpha')
    expect(agentRegistry.get('alpha')).toBeUndefined()
  })
})
