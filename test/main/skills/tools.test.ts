import path from 'node:path'
import { SKILL_FILE, skillRegistry } from '../../../src/main/skills/registry'
import { loadSkillTool, readSkillFileTool } from '../../../src/main/skills/tools'
import { builtinTools, createToolRunner } from '../../../src/main/tools/registry'
import { resetSettings } from '../../helpers/settings'
import {
  makeTempDir,
  releaseCatalog,
  removeTempDir,
  skillDoc,
  useCatalog,
  writeFiles
} from '../../helpers/temp'

const ctx = { callId: 'call-1' }
const runner = createToolRunner([loadSkillTool, readSkillFileTool])

let root = ''
let agentsRoot = ''

beforeEach(() => {
  root = makeTempDir()
  agentsRoot = makeTempDir()
  useCatalog(root, agentsRoot)
  resetSettings()
  skillRegistry.scan()
})

afterEach(() => {
  releaseCatalog()
  removeTempDir(root)
  removeTempDir(agentsRoot)
  resetSettings()
})

const args = (value: Record<string, string>): string => JSON.stringify(value)

describe('load_skill', () => {
  it('返回正文与附属文件清单', async () => {
    writeFiles(root, {
      [`pptx/${SKILL_FILE}`]: skillDoc('pptx', '做 PPT', '# 步骤\n先建模板'),
      'pptx/references/guide.md': '指南',
      'pptx/assets/template.html': '<html>'
    })
    skillRegistry.scan()
    expect(await runner.execute('load_skill', args({ name: 'pptx' }), ctx)).toEqual({
      ok: true,
      result:
        '# Skill: pptx\n\n# 步骤\n先建模板\n\n---\n该 skill 附带的文件(可用 read_skill_file 读取):\n- assets/template.html\n- references/guide.md'
    })
  })

  it('没有附属文件时不输出清单段落', async () => {
    writeFiles(root, { [`solo/${SKILL_FILE}`]: skillDoc('solo', '独立技能', '只有一段说明') })
    skillRegistry.scan()
    expect(await runner.execute('load_skill', args({ name: 'solo' }), ctx)).toEqual({
      ok: true,
      result: '# Skill: solo\n\n只有一段说明'
    })
  })

  it('名字缺失或不存在都转成 ok=false 交给模型自纠', async () => {
    expect(await runner.execute('load_skill', args({ name: '  ' }), ctx)).toEqual({
      ok: false,
      result: '缺少 name'
    })
    expect(await runner.execute('load_skill', args({ name: 'ghost' }), ctx)).toEqual({
      ok: false,
      result: 'skill "ghost" 不存在'
    })
  })

  it('参数不是 JSON 时由注册表拦下,工具不会被调用', async () => {
    expect(await runner.execute('load_skill', 'pptx', ctx)).toEqual({
      ok: false,
      result: '参数不是合法的 JSON:pptx'
    })
  })
})

describe('read_skill_file', () => {
  beforeEach(() => {
    writeFiles(root, {
      [`pptx/${SKILL_FILE}`]: skillDoc('pptx', '做 PPT'),
      'pptx/references/guide.md': '# 指南正文',
      'pptx/logo.png': 'binary'
    })
    skillRegistry.scan()
  })

  it('按相对路径读出文件内容', async () => {
    expect(
      await runner.execute(
        'read_skill_file',
        args({ name: 'pptx', path: 'references/guide.md' }),
        ctx
      )
    ).toEqual({ ok: true, result: '# 指南正文' })
  })

  it('缺 name 或 path 都给出同一句说明', async () => {
    expect(await runner.execute('read_skill_file', args({ name: 'pptx' }), ctx)).toMatchObject({
      ok: false,
      result: '缺少 name 或 path'
    })
    expect(
      await runner.execute('read_skill_file', args({ path: 'references/guide.md' }), ctx)
    ).toMatchObject({ ok: false, result: '缺少 name 或 path' })
  })

  it('越界与二进制文件由 registry 挡住,错误原样回传给模型', async () => {
    expect(
      await runner.execute(
        'read_skill_file',
        args({ name: 'pptx', path: path.join(root, 'escape.md') }),
        ctx
      )
    ).toEqual({ ok: false, result: '只能读取该 skill 目录内的文件' })
    expect(
      await runner.execute('read_skill_file', args({ name: 'pptx', path: 'logo.png' }), ctx)
    ).toEqual({ ok: false, result: '不支持读取该类型的文件:.png' })
  })
})

describe('工具挂载', () => {
  it('两个 skill 工具都在内置工具里,名字与声明一致', () => {
    expect(builtinTools.map((t) => t.name)).toEqual([
      'get_current_time',
      'load_skill',
      'read_skill_file'
    ])
  })

  it('参数 schema 声明了必填项', () => {
    expect(loadSkillTool.parameters.required).toEqual(['name'])
    expect(readSkillFileTool.parameters.required).toEqual(['name', 'path'])
  })
})
