import type { ITheme } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { xtermTheme, type XtermPalette } from '../../../src/renderer/src/lib/xtermTheme'
import { withAlpha } from '../../../src/renderer/src/theme'

const LIGHT: XtermPalette = {
  colorBgContainer: '#FFFFFF',
  colorText: '#211F1C',
  colorTextSecondary: '#5F5C56',
  colorBorder: '#D8D5CF',
  colorPrimary: '#D9480F'
}

const DARK: XtermPalette = {
  colorBgContainer: '#1F1E1B',
  colorText: '#F0EDE6',
  colorTextSecondary: '#B9B4AA',
  colorBorder: '#45423B',
  colorPrimary: '#FF922B'
}

const ANSI_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const

function colorsOf(theme: ITheme): string[] {
  return Object.values(theme).filter((value): value is string => typeof value === 'string')
}

describe('xtermTheme', () => {
  it('背景、正文、光标与选区跟着界面令牌走', () => {
    const theme = xtermTheme(LIGHT, false)
    expect(theme.background).toBe(LIGHT.colorBgContainer)
    expect(theme.foreground).toBe(LIGHT.colorText)
    expect(theme.cursor).toBe(LIGHT.colorPrimary)
    expect(theme.cursorAccent).toBe(LIGHT.colorBgContainer)
    expect(theme.selectionBackground).toBe(withAlpha(LIGHT.colorPrimary, 0.25))
  })

  it('暗色下选区透明度更高:深底上的淡染要更浓才看得见', () => {
    expect(xtermTheme(DARK, true).selectionBackground).toBe(withAlpha(DARK.colorPrimary, 0.35))
  })

  it('16 色 ANSI 全部给齐,不留 xterm 默认值', () => {
    const theme = xtermTheme(LIGHT, false) as Record<string, unknown>
    for (const key of ANSI_KEYS) {
      expect(theme[key]).toMatch(/^#[0-9A-F]{6}$/)
    }
  })

  it('明暗两套的 ANSI 值不同:同一份配色在两种底色上不可能都读得清', () => {
    const light = xtermTheme(LIGHT, false) as Record<string, unknown>
    const dark = xtermTheme(DARK, true) as Record<string, unknown>
    for (const key of ANSI_KEYS) {
      expect(light[key]).not.toBe(dark[key])
    }
  })

  it('不出现 antd 官方蓝:终端里最刺眼的那一格正是它', () => {
    for (const theme of [xtermTheme(LIGHT, false), xtermTheme(DARK, true)]) {
      const offenders = colorsOf(theme).filter((color) => color.toLowerCase().includes('1677ff'))
      expect(offenders).toEqual([])
    }
  })

  it('不改写 selectionForeground:让 xterm 保留字符原色', () => {
    expect(xtermTheme(DARK, true).selectionForeground).toBeUndefined()
  })
})
