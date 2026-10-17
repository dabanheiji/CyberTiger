import { describe, expect, it } from 'vitest'
import { darkTheme, lightTheme, withAlpha } from '../../src/renderer/src/theme'

describe('withAlpha:十六进制色转 rgba', () => {
  it('按位拆出三个通道,透明度原样带上', () => {
    expect(withAlpha('#D9480F', 0.12)).toBe('rgba(217, 72, 15, 0.12)')
  })

  it('黑白是两个端点,通道不串位', () => {
    expect(withAlpha('#000000', 1)).toBe('rgba(0, 0, 0, 1)')
    expect(withAlpha('#FFFFFF', 0.5)).toBe('rgba(255, 255, 255, 0.5)')
  })
})

describe('明暗两套令牌', () => {
  it('token 的键集合一致 —— 浅色加了某个令牌而深色忘了,暗色下就会静默退回库默认值', () => {
    expect(Object.keys(lightTheme.token ?? {}).sort()).toEqual(
      Object.keys(darkTheme.token ?? {}).sort()
    )
  })

  it('components 的覆盖面一致 —— 同理,少覆盖的那一侧会露出 antd 默认外观', () => {
    expect(Object.keys(lightTheme.components ?? {}).sort()).toEqual(
      Object.keys(darkTheme.components ?? {}).sort()
    )
  })

  it('强调色不是 antd 默认蓝,两套各自一个值', () => {
    expect(lightTheme.token?.colorPrimary).not.toBe('#1677ff')
    expect(darkTheme.token?.colorPrimary).not.toBe(lightTheme.token?.colorPrimary)
  })
})
