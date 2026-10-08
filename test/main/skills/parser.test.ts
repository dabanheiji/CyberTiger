import { parseSkillFile, replaceArguments } from '../../../src/main/skills/parser'

function skillFile(front: string, body = '指令正文'): string {
  return `---\n${front}\n---\n${body}`
}

const MINIMAL = 'name: demo-skill\ndescription: 一个示例技能'

describe('parseSkillFile', () => {
  it('解析最小合法文件,可选字段缺省为 undefined', () => {
    const parsed = parseSkillFile(skillFile(MINIMAL))
    expect(parsed).toEqual({
      name: 'demo-skill',
      description: '一个示例技能',
      license: undefined,
      compatibility: undefined,
      metadata: undefined,
      body: '指令正文'
    })
  })

  it('description 缺失或只有空格都报错', () => {
    expect(() => parseSkillFile(skillFile('name: demo-skill'))).toThrow('缺少 description')
    expect(() => parseSkillFile(skillFile('name: demo-skill\ndescription: "   "'))).toThrow(
      '缺少 description'
    )
  })

  it('description 以 1024 为硬上限', () => {
    const atLimit = skillFile(`name: demo-skill\ndescription: ${'x'.repeat(1024)}`)
    expect(parseSkillFile(atLimit).description.length).toBe(1024)
    const overLimit = skillFile(`name: demo-skill\ndescription: ${'x'.repeat(1025)}`)
    expect(() => parseSkillFile(overLimit)).toThrow('description 不能超过 1024 个字符')
  })

  it('description 两端空白被去掉', () => {
    const parsed = parseSkillFile(skillFile('name: demo-skill\ndescription: "  带空格  "'))
    expect(parsed.description).toBe('带空格')
  })

  it('name 与目录名不一致时报错', () => {
    expect(() => parseSkillFile(skillFile(MINIMAL), 'other-dir')).toThrow(
      'name "demo-skill" 必须与目录名 "other-dir" 一致'
    )
    expect(parseSkillFile(skillFile(MINIMAL), 'demo-skill').name).toBe('demo-skill')
  })

  it('license 与 compatibility 各自有 500 上限且必须是字符串', () => {
    expect(() => parseSkillFile(skillFile(`${MINIMAL}\nlicense: ${'y'.repeat(501)}`))).toThrow(
      'license 不能超过 500 个字符'
    )
    expect(() => parseSkillFile(skillFile(`${MINIMAL}\ncompatibility: 3`))).toThrow(
      'compatibility 必须是字符串'
    )
  })

  it('metadata 的非字符串值统一转成字符串', () => {
    const parsed = parseSkillFile(
      skillFile(`${MINIMAL}\nmetadata:\n  version: 3\n  author: tom\n  ratio: 0.5`)
    )
    expect(parsed.metadata).toEqual({ version: '3', author: 'tom', ratio: '0.5' })
  })

  it('metadata 是数组时报错', () => {
    expect(() => parseSkillFile(skillFile(`${MINIMAL}\nmetadata:\n  - a`))).toThrow(
      'metadata 必须是键值映射'
    )
  })

  it('正文两端空白被去掉', () => {
    const parsed = parseSkillFile(skillFile(MINIMAL, '\n\n  步骤一  \n\n'))
    expect(parsed.body).toBe('步骤一')
  })
})

describe('replaceArguments', () => {
  it('正文里的 $ARGUMENTS 全部替换为用户输入', () => {
    expect(replaceArguments('先做 $ARGUMENTS,再做 $ARGUMENTS', 'A')).toBe('先做 A,再做 A')
  })

  it('没有占位符时把输入追加到末尾', () => {
    expect(replaceArguments('固定指令', '用户的话')).toBe('固定指令\n\n用户输入:\n用户的话')
  })

  it('有占位符但输入为空时替换成空串,不追加', () => {
    expect(replaceArguments('执行 $ARGUMENTS 吧', '   ')).toBe('执行  吧')
  })

  it('无占位符且输入为空时正文原样返回', () => {
    expect(replaceArguments('固定指令', '')).toBe('固定指令')
    expect(replaceArguments('固定指令', '   ')).toBe('固定指令')
  })

  it('追加时会先去掉输入两端空白', () => {
    expect(replaceArguments('指南', '\n  带换行  \n')).toBe('指南\n\n用户输入:\n带换行')
  })
})
