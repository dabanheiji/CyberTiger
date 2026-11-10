import type { ITheme } from '@xterm/xterm'
import { withAlpha } from '../theme'

/** 终端主题只吃这几格令牌:背景 / 正文 / 次要文字 / 描边 / 强调色 */
export interface XtermPalette {
  colorBgContainer: string
  colorText: string
  colorTextSecondary: string
  colorBorder: string
  colorPrimary: string
}

interface AnsiPalette {
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

/**
 * 16 色 ANSI 的暖色中性值。
 *
 * 浅色下「亮色」按对比度解释成更深的那一档:白底上再亮就是看不见,而 `vim` / `ls --color`
 * 里的 bright 系列本来就是为了「更显眼」,不是为了让颜色变白。
 */
const ANSI_LIGHT: AnsiPalette = {
  black: '#211F1C',
  red: '#B23A2A',
  green: '#4A7A2D',
  yellow: '#8F6A10',
  blue: '#3D63A5',
  magenta: '#8A4A8A',
  cyan: '#2B7476',
  white: '#B9B4AA',
  brightBlack: '#5F5C56',
  brightRed: '#D0483F',
  brightGreen: '#5E9440',
  brightYellow: '#B5860F',
  brightBlue: '#5479BF',
  brightMagenta: '#A85AA8',
  brightCyan: '#368A8C',
  brightWhite: '#3B3833'
}

const ANSI_DARK: AnsiPalette = {
  black: '#3B3833',
  red: '#E06C75',
  green: '#98C379',
  yellow: '#E5C07B',
  blue: '#61AFEF',
  magenta: '#C678DD',
  cyan: '#56B6C2',
  white: '#F0EDE6',
  brightBlack: '#8A857C',
  brightRed: '#FF7B86',
  brightGreen: '#B4D98F',
  brightYellow: '#F0D090',
  brightBlue: '#7FC1FF',
  brightMagenta: '#D992EE',
  brightCyan: '#6FD3DE',
  brightWhite: '#FFFFFF'
}

/**
 * 把界面令牌翻成 xterm 主题。背景 / 正文 / 光标 / 选区一律跟着强调色与明暗走,
 * ANSI 那 16 格用本文件的暖色值 —— 组件里不写任何十六进制,换色只需换令牌。
 */
export function xtermTheme(palette: XtermPalette, isDark: boolean): ITheme {
  const ansi = isDark ? ANSI_DARK : ANSI_LIGHT
  return {
    background: palette.colorBgContainer,
    foreground: palette.colorText,
    cursor: palette.colorPrimary,
    cursorAccent: palette.colorBgContainer,
    selectionBackground: withAlpha(palette.colorPrimary, isDark ? 0.35 : 0.25),
    black: ansi.black,
    red: ansi.red,
    green: ansi.green,
    yellow: ansi.yellow,
    blue: ansi.blue,
    magenta: ansi.magenta,
    cyan: ansi.cyan,
    white: ansi.white,
    brightBlack: ansi.brightBlack,
    brightRed: ansi.brightRed,
    brightGreen: ansi.brightGreen,
    brightYellow: ansi.brightYellow,
    brightBlue: ansi.brightBlue,
    brightMagenta: ansi.brightMagenta,
    brightCyan: ansi.brightCyan,
    brightWhite: ansi.brightWhite
  }
}
