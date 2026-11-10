import { describe, expect, it } from 'vitest'
import {
  markdownVars,
  normalizeCodeLang,
  type MarkdownPalette,
  type MarkdownStyle
} from '../../../src/renderer/src/lib/markdownTheme'

/** 一份假的令牌:值刻意不用官方主题的默认色,断言才能区分「取自令牌」与「取自主题」 */
const palette: MarkdownPalette = {
  colorPrimary: '#D9480F',
  colorPrimaryHover: '#E8590C',
  colorTextHeading: '#211F1C',
  colorText: '#3B3833',
  colorBorderSecondary: '#EBE9E4',
  colorSplit: '#D8D5CF',
  colorFillTertiary: '#F1F0ED',
  colorFillQuaternary: '#F5F4F1',
  colorBgContainer: '#FFFFFF',
  borderRadius: 8,
  borderRadiusSM: 6,
  fontSize: 14
}

describe('markdownVars', () => {
  it('链接颜色取自强调色,不是官方主题那支蓝', () => {
    const vars = markdownVars(palette, false)
    expect(vars['--primary-color']).toBe('#D9480F')
    expect(vars['--primary-color-hover']).toBe('#E8590C')
    expect(vars['--primary-color']).not.toBe('#1677ff')
  })

  it('正文、标题、描边、分隔线逐项取自令牌', () => {
    const vars = markdownVars(palette, false)
    expect(vars['--text-color']).toBe('#3B3833')
    expect(vars['--heading-color']).toBe('#211F1C')
    expect(vars['--border-color']).toBe('#EBE9E4')
    expect(vars['--line-color']).toBe('#D8D5CF')
  })

  it('表格与引用各用一层底色,表体落在画布色上', () => {
    const vars = markdownVars(palette, false)
    expect(vars['--table-head-bg']).toBe('#F5F4F1')
    expect(vars['--table-body-bg']).toBe('#FFFFFF')
    expect(vars['--cite-bg']).toBe('#F5F4F1')
    expect(vars['--cite-hover-bg']).toBe('#F1F0ED')
  })

  it('明暗两套只差代码块背景那个变量名,值都是 colorFillTertiary', () => {
    const light = markdownVars(palette, false)
    const dark = markdownVars(palette, true)
    expect(light['--light-bg']).toBe('#F1F0ED')
    expect(light['--dark-bg']).toBeUndefined()
    expect(dark['--dark-bg']).toBe('#F1F0ED')
    expect(dark['--light-bg']).toBeUndefined()

    const withoutBg = (vars: MarkdownStyle): MarkdownStyle => {
      const rest = { ...vars }
      delete rest['--light-bg']
      delete rest['--dark-bg']
      return rest
    }
    expect(withoutBg(light)).toEqual(withoutBg(dark))
  })

  it('圆角与字号拼上 px,数字原样出来不会是 NaN', () => {
    const vars = markdownVars(palette, false)
    expect(vars['--border-radius-middle']).toBe('8px')
    expect(vars['--border-radius-small']).toBe('6px')
    expect(vars['--font-size']).toBe('14px')
  })
})

describe('normalizeCodeLang', () => {
  it('常见短名收敛到 Prism 的规范名,大小写不敏感', () => {
    expect(normalizeCodeLang('js')).toBe('javascript')
    expect(normalizeCodeLang('TS')).toBe('typescript')
    expect(normalizeCodeLang('sh')).toBe('bash')
    expect(normalizeCodeLang('py')).toBe('python')
    expect(normalizeCodeLang('yml')).toBe('yaml')
    expect(normalizeCodeLang('md')).toBe('markdown')
    expect(normalizeCodeLang('html')).toBe('markup')
    expect(normalizeCodeLang('dockerfile')).toBe('docker')
    expect(normalizeCodeLang('shellscript')).toBe('bash')
    expect(normalizeCodeLang('cs')).toBe('csharp')
    expect(normalizeCodeLang('rb')).toBe('ruby')
    expect(normalizeCodeLang('rs')).toBe('rust')
    expect(normalizeCodeLang('kt')).toBe('kotlin')
    expect(normalizeCodeLang('golang')).toBe('go')
    expect(normalizeCodeLang('ps1')).toBe('powershell')
  })

  it('info string 带参数时只取第一个词', () => {
    expect(normalizeCodeLang('ts title=foo')).toBe('typescript')
    expect(normalizeCodeLang('  bash  ')).toBe('bash')
  })

  it('没有语言、空白与纯文本都按普通代码块处理', () => {
    expect(normalizeCodeLang(undefined)).toBeUndefined()
    expect(normalizeCodeLang('')).toBeUndefined()
    expect(normalizeCodeLang('   ')).toBeUndefined()
    expect(normalizeCodeLang('text')).toBeUndefined()
    expect(normalizeCodeLang('plaintext')).toBeUndefined()
    expect(normalizeCodeLang('plain')).toBeUndefined()
  })

  it('未知语言原样传出,交给高亮器自己退回纯文本', () => {
    expect(normalizeCodeLang('not-a-language')).toBe('not-a-language')
  })
})
