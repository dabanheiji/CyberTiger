import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ACCENT_DARK,
  DEFAULT_ACCENT_LIGHT,
  buildTheme,
  defaultAccent,
  deriveAccent,
  focusRing,
  hexToHsl,
  readableInk,
  selectionTint,
  withAlpha
} from '../../src/renderer/src/theme'

describe('withAlpha:十六进制色转 rgba', () => {
  it('按位拆出三个通道,透明度原样带上', () => {
    expect(withAlpha('#D9480F', 0.12)).toBe('rgba(217, 72, 15, 0.12)')
  })

  it('黑白是两个端点,通道不串位', () => {
    expect(withAlpha('#000000', 1)).toBe('rgba(0, 0, 0, 1)')
    expect(withAlpha('#FFFFFF', 0.5)).toBe('rgba(255, 255, 255, 0.5)')
  })
})

describe('deriveAccent:把用户选的一个颜色收进当前那侧的明度区间', () => {
  it('默认那一对原样穿过 —— 区间是以它们为锚定的,调了区间就会悄悄换掉品牌色', () => {
    expect(deriveAccent(DEFAULT_ACCENT_LIGHT, false)).toBe(DEFAULT_ACCENT_LIGHT)
    expect(deriveAccent(DEFAULT_ACCENT_DARK, true)).toBe(DEFAULT_ACCENT_DARK)
  })

  it('已经在区间内也只归一大小写,不重算颜色', () => {
    expect(deriveAccent('#1677ff', false)).toBe('#1677FF')
  })

  it('过暗的自定义色被抬进区间,而色相与饱和度一动不动', () => {
    const dark = hexToHsl('#0958d9')
    const derived = hexToHsl(deriveAccent('#0958d9', true))
    expect(derived.l).toBeCloseTo(52, 0)
    expect(derived.h).toBeCloseTo(dark.h, 0)
    expect(derived.s).toBeCloseTo(dark.s, 0)
  })

  it('过亮的自定义色在浅色下被压暗:选近白等于什么都看不见', () => {
    expect(hexToHsl(deriveAccent('#bae0ff', false)).l).toBeCloseTo(55, 0)
  })

  it('脏值回落到默认色而不是产出 #NaNNaNNaN:config.json 是用户可编辑的', () => {
    expect(deriveAccent('#xyz', false)).toBe(DEFAULT_ACCENT_LIGHT)
    expect(deriveAccent('', true)).toBe(DEFAULT_ACCENT_DARK)
  })
})

describe('readableInk:强调色当按钮底色时上面写什么色的字', () => {
  it('亮橙(#FF922B)托不住白字,换成近黑的暖调', () => {
    expect(readableInk('#FF922B')).toBe('#1A1206')
  })

  it('中等明度的蓝与深橙用白字', () => {
    expect(readableInk('#1677ff')).toBe('#FFFFFF')
    expect(readableInk(DEFAULT_ACCENT_LIGHT)).toBe('#FFFFFF')
  })
})

describe('buildTheme:一个强调色 + 明暗,产出一套完整令牌', () => {
  const accents = [DEFAULT_ACCENT_LIGHT, '#1677ff', '#1A0F00', '#bae0ff']

  for (const accent of accents) {
    it(`${accent}:token 的键集合一致 —— 明暗各自少写一个中性色,那一侧就静默退回 antd 默认值`, () => {
      expect(Object.keys(buildTheme(false, accent).token ?? {}).sort()).toEqual(
        Object.keys(buildTheme(true, accent).token ?? {}).sort()
      )
    })

    it(`${accent}:components 的覆盖面一致,主按钮的文字色两侧都得有`, () => {
      expect(Object.keys(buildTheme(false, accent).components ?? {}).sort()).toEqual(
        Object.keys(buildTheme(true, accent).components ?? {}).sort()
      )
      expect(buildTheme(true, accent).components?.Button?.primaryColor).toBeTruthy()
    })

    it(`${accent}:发出去的 colorPrimary 落在当前那侧的区间里,而不是用户原始的那个色`, () => {
      // 半个百分点的余量:算完 HSL 要落回 8 位整数色,再读回来就是 51.96 而不是 52
      const light = hexToHsl(String(buildTheme(false, accent).token?.colorPrimary)).l
      const dark = hexToHsl(String(buildTheme(true, accent).token?.colorPrimary)).l
      expect(light).toBeGreaterThanOrEqual(37.5)
      expect(light).toBeLessThanOrEqual(55.5)
      expect(dark).toBeGreaterThanOrEqual(51.5)
      expect(dark).toBeLessThanOrEqual(70.5)
    })
  }

  it('强调色不是 antd 默认蓝,而且没自定义时明暗各用品牌那一对', () => {
    expect(buildTheme(false, DEFAULT_ACCENT_LIGHT).token?.colorPrimary).not.toBe('#1677ff')
    expect(defaultAccent(false)).not.toBe(defaultAccent(true))
  })
})

describe('选区与焦点环:与 main.css 里那份兜底值必须同字', () => {
  it('浅色两处都是 rgba(217, 72, 15, …)', () => {
    expect(selectionTint(defaultAccent(false), false)).toBe('rgba(217, 72, 15, 0.2)')
    expect(focusRing(defaultAccent(false), false)).toBe('rgba(217, 72, 15, 0.55)')
  })

  it('深色两处都是 rgba(255, 146, 43, …),且比浅色更透一档才压得过深底', () => {
    expect(selectionTint(defaultAccent(true), true)).toBe('rgba(255, 146, 43, 0.28)')
    expect(focusRing(defaultAccent(true), true)).toBe('rgba(255, 146, 43, 0.65)')
  })
})
