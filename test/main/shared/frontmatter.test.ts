import {
  NAME_RE,
  asOptionalString,
  parseFrontmatter,
  splitFrontmatter,
  validateName
} from '../../../src/main/shared/frontmatter'

describe('splitFrontmatter', () => {
  it('拆出 yaml 与正文', () => {
    const { yaml, body } = splitFrontmatter('---\nname: demo\ndescription: x\n---\n正文第一行\n')
    expect(yaml).toBe('name: demo\ndescription: x')
    expect(body).toBe('正文第一行\n')
  })

  it('容忍 BOM 与 CRLF', () => {
    // \uFEFF 用转义写,遵循 shared/frontmatter.ts 里"源码不出现不可见字符"的约定
    const withBom = splitFrontmatter('\uFEFF---\nname: demo\n---\nbody')
    const withCrlf = splitFrontmatter('---\r\nname: demo\r\n---\r\nbody')
    expect(withBom.yaml).toBe('name: demo')
    expect(withCrlf.body).toBe('body')
  })

  it('结束的 --- 后直接换行时正文开头不留空行', () => {
    expect(splitFrontmatter('---\na: 1\n---\nbody').body).toBe('body')
  })

  it('结尾 --- 之后没有内容时正文为空串', () => {
    expect(splitFrontmatter('---\na: 1\n---').body).toBe('')
  })

  it('不以 --- 开头时报错', () => {
    expect(() => splitFrontmatter('name: demo\n---\nbody')).toThrow(
      '必须以 YAML frontmatter(---)开头'
    )
  })

  it('缺少结束的 --- 时报错', () => {
    expect(() => splitFrontmatter('---\nname: demo\nbody')).toThrow('frontmatter 缺少结束的 ---')
  })

  it('只有 --- 前缀但没有结束标记时报错', () => {
    expect(() => splitFrontmatter('----\nname: demo')).toThrow()
  })
})

describe('parseFrontmatter', () => {
  it('解析成键值映射并返回正文', () => {
    const { data, body } = parseFrontmatter('---\nname: demo\ncount: 3\n---\n指令正文')
    expect(data).toEqual({ name: 'demo', count: 3 })
    expect(body).toBe('指令正文')
  })

  it('frontmatter 是数组时报错', () => {
    expect(() => parseFrontmatter('---\n- a\n- b\n---\nbody')).toThrow('frontmatter 必须是键值映射')
  })

  it('frontmatter 是标量时报错', () => {
    expect(() => parseFrontmatter('---\njust text\n---\nbody')).toThrow(
      'frontmatter 必须是键值映射'
    )
  })

  it('frontmatter 为空时报错', () => {
    expect(() => parseFrontmatter('---\n\n---\nbody')).toThrow('frontmatter 必须是键值映射')
  })

  it('紧挨着开标记的 --- 会被判成缺少结束标记', () => {
    // 结束标记的查找从索引 4 开始,所以 ---\n--- 这种写法永远配不成"空 frontmatter"
    expect(() => parseFrontmatter('---\n---\nbody')).toThrow('frontmatter 缺少结束的 ---')
  })

  it('YAML 语法非法时报错并带上原因', () => {
    expect(() => parseFrontmatter('---\nname: [未闭合\n---\nbody')).toThrow(
      /^frontmatter 不是合法的 YAML:/
    )
  })
})

describe('asOptionalString', () => {
  it('未提供或为 null 时返回 undefined', () => {
    expect(asOptionalString(undefined, 'license', 500)).toBeUndefined()
    expect(asOptionalString(null, 'license', 500)).toBeUndefined()
  })

  it('非字符串报错并带上字段名', () => {
    expect(() => asOptionalString(3, 'provider', 40)).toThrow('provider 必须是字符串')
  })

  it('超长报错并带上上限', () => {
    expect(() => asOptionalString('abcdef', 'model', 5)).toThrow('model 不能超过 5 个字符')
  })

  it('合法值原样返回,不做 trim', () => {
    expect(asOptionalString('  spaced  ', 'model', 40)).toBe('  spaced  ')
    expect(asOptionalString('abcde', 'model', 5)).toBe('abcde')
  })
})

describe('validateName', () => {
  it('接受 kebab-case 的合法形式', () => {
    for (const name of ['a', 'a1', 'demo-skill', 'pdf-forms-2', '123']) {
      expect(validateName(name)).toBe(name)
    }
  })

  it('拒绝大写、下划线与空值', () => {
    for (const bad of ['Demo', 'demo_skill', '', '-demo', 'demo-', 'de--mo', ' demo ']) {
      expect(() => validateName(bad)).toThrow(/name/)
    }
  })

  it('非字符串按缺失处理', () => {
    expect(() => validateName(undefined)).toThrow('缺少 name')
    expect(() => validateName(42)).toThrow('缺少 name')
  })

  it('超过 64 字符报错', () => {
    const long = `a-${'b'.repeat(64)}`
    expect(() => validateName(long)).toThrow('name 不能超过 64 个字符')
  })

  it('dirName 给定时要求与目录名一致', () => {
    expect(validateName('demo', 'demo')).toBe('demo')
    expect(() => validateName('other', 'demo')).toThrow('name "other" 必须与目录名 "demo" 一致')
  })

  it('dirName 为 undefined 时跳过目录名校验,传空串则要求空串名', () => {
    expect(validateName('demo', undefined)).toBe('demo')
    expect(() => validateName('demo', '')).toThrow('必须与目录名')
  })

  it('NAME_RE 与校验函数保持一致', () => {
    expect(NAME_RE.test('demo-skill')).toBe(true)
    expect(NAME_RE.test('Demo')).toBe(false)
    expect(NAME_RE.test('')).toBe(false)
  })
})
