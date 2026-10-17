import { theme } from 'antd'
import type { XProviderProps } from '@ant-design/x'

/**
 * XProvider 的 theme 形状:antd 的 ThemeConfig 再并入 x 自己的组件令牌
 * (Bubble / Conversations / Sender / Think / ThoughtChain / Welcome),
 * 所以这一个模块同时喂 antd 与 x。
 */
type AppTheme = NonNullable<XProviderProps['theme']>

/**
 * 界面字体栈。Inter 走本地打包的 latin 子集;汉字按字形回退到系统中文字体 ——
 * Inter 没有汉字字形,栈里必须显式列出中文,否则中文会落到浏览器兜底的那一个。
 * 与 main.css 的 body 规则是同一串,改一处要改两处。
 */
export const FONT_SANS =
  "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Ubuntu, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif"

/** 等宽字体栈:用系统等宽而不打包 —— 代码块里的中文注释让打包中文字体不划算 */
export const FONT_MONO =
  "'JetBrains Mono', 'SF Mono', ui-monospace, 'Cascadia Code', Menlo, Consolas, 'Liberation Mono', monospace"

/**
 * 未自定义时的强调色(虎橙)。浅色 #D9480F 对白底撑得住正文;深色下要更亮才压得过
 * #1F1E1B 的画布底,手工换成 #FF922B。这一对是品牌色,也是 `LIGHTNESS_BAND` 两端区间的
 * 锚点 —— 用户没挑颜色时它们原样穿过 `deriveAccent`,不会因为区间调整而悄悄换色。
 */
export const DEFAULT_ACCENT_LIGHT = '#D9480F'
export const DEFAULT_ACCENT_DARK = '#FF922B'

/** 外观设置里没有 accent 时用这一对;`App.tsx` 与色盘的「恢复默认」都走这里 */
export function defaultAccent(isDark: boolean): string {
  return isDark ? DEFAULT_ACCENT_DARK : DEFAULT_ACCENT_LIGHT
}

/** 强调色作按钮底色时上面该写深色字(近黑的暖调)还是白字 */
const INK_ON_ACCENT = '#1A1206'

/** 只接受 #RRGGBB:config.json 是用户可编辑的,脏值会让颜色数学产出 #NaNNaNNaN */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/** #RRGGBB → rgba()。淡染与光晕都要在强调色上取透明,颜色字面量只该出现在本文件 */
export function withAlpha(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex)
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`
}

/** 色相 0~360 度,饱和度与明度各 0~100% */
export interface Hsl {
  h: number
  s: number
  l: number
}

export function hexToHsl(hex: string): Hsl {
  const rgb = hexToRgb(hex)
  const r = rgb[0] / 255
  const g = rgb[1] / 255
  const b = rgb[2] / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  const light = (max + min) / 2
  if (delta === 0) return { h: 0, s: 0, l: light * 100 }
  const sat = delta / (1 - Math.abs(2 * light - 1))
  const hue = max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  return { h: (((hue * 60) % 360) + 360) % 360, s: sat * 100, l: light * 100 }
}

function toHexSrgb(channels: [number, number, number]): string {
  const bytes = channels.map((c) => Math.round(clamp(c, 0, 1) * 255))
  return `#${bytes
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = clamp(s, 0, 100) / 100
  const light = clamp(l, 0, 100) / 100
  const chroma = (1 - Math.abs(2 * light - 1)) * sat
  const hue = ((((h % 360) + 360) % 360) / 60) % 6
  const second = chroma * (1 - Math.abs((hue % 2) - 1))
  const sector: [number, number, number] =
    hue < 1
      ? [chroma, second, 0]
      : hue < 2
        ? [second, chroma, 0]
        : hue < 3
          ? [0, chroma, second]
          : hue < 4
            ? [0, second, chroma]
            : hue < 5
              ? [second, 0, chroma]
              : [chroma, 0, second]
  const match = light - chroma / 2
  return toHexSrgb([sector[0] + match, sector[1] + match, sector[2] + match])
}

/**
 * 强调色的明度安全区间(%),按明暗各一套。
 * 上限管住浅色:再亮就撑不住白底上的正文与描边;下限管住暗色:再暗就压不过深色画布。
 * 只动明度,色相与饱和度保留 —— 用户选蓝色不会因为切到暗色而变紫。
 * 两个区间的边界以默认色为锚:#D9480F(l≈45)与 #FF922B(l≈58)各自落在自己那一侧内。
 */
const LIGHTNESS_BAND: { light: [number, number]; dark: [number, number] } = {
  light: [38, 55],
  dark: [52, 70]
}

/** 把用户选的强调色收进当前那侧的明度区间;已经在区间内就一个字节都不改 */
export function deriveAccent(accentHex: string, isDark: boolean): string {
  if (!HEX_COLOR.test(accentHex)) return defaultAccent(isDark)
  const { h, s, l } = hexToHsl(accentHex)
  const band = isDark ? LIGHTNESS_BAND.dark : LIGHTNESS_BAND.light
  if (l >= band[0] && l <= band[1]) return accentHex.toUpperCase()
  return hslToHex(h, s, clamp(l, band[0], band[1]))
}

function toLinear(channel: number): number {
  const s = channel / 255
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

/** WCAG 相对亮度,只用来决定主按钮上写深字还是白字 */
function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex)
  return 0.2126 * toLinear(rgb[0]) + 0.7152 * toLinear(rgb[1]) + 0.0722 * toLinear(rgb[2])
}

export function readableInk(accentHex: string): string {
  return relativeLuminance(accentHex) > 0.4 ? INK_ON_ACCENT : '#FFFFFF'
}

/**
 * 选区底色与键盘焦点环。渲染层把它们写成 CSS 变量,`main.css` 里同值留一份兜底 ——
 * 强调色由 JS 注入,首帧那时变量还没有。
 */
export function selectionTint(accentHex: string, isDark: boolean): string {
  return withAlpha(deriveAccent(accentHex, isDark), isDark ? 0.28 : 0.2)
}

export function focusRing(accentHex: string, isDark: boolean): string {
  return withAlpha(deriveAccent(accentHex, isDark), isDark ? 0.65 : 0.55)
}

/**
 * 明暗共用的尺度。fontSize 保持默认 14(中文在 13px 下劣化明显,密度靠间距),
 * controlHeight 保持默认 32(动了会牵动输入区 footer 那条基线)。
 */
const sharedToken = {
  borderRadius: 8,
  borderRadiusLG: 12,
  borderRadiusSM: 6,
  fontFamily: FONT_SANS,
  fontFamilyCode: FONT_MONO
}

/**
 * 中性色:三级海拔与描边、阴影。浅色是暖纸(侧栏 colorBgLayout 凹陷 → 画布 colorBgContainer
 * → 浮层 colorBgElevated + 阴影),深色下 darkAlgorithm 给的是接近纯黑的冷调,做不出海拔,
 * 所以三档背景都指定成暖色,层次靠背景差而不是 1px 边框。
 * 两套的键集合必须一致 —— 少一个键,那一侧就静默退回 antd 默认值(有单测守着)。
 */
const NEUTRALS_LIGHT = {
  colorTextBase: '#211F1C',
  colorBgLayout: '#F5F4F1',
  colorBgContainer: '#FFFFFF',
  colorBgElevated: '#FFFFFF',
  colorBorder: '#D8D5CF',
  colorBorderSecondary: '#EBE9E4',
  boxShadow: '0 1px 2px rgba(33, 31, 28, 0.05), 0 4px 12px rgba(33, 31, 28, 0.08)',
  boxShadowSecondary: '0 3px 6px rgba(33, 31, 28, 0.08), 0 8px 24px rgba(33, 31, 28, 0.1)',
  boxShadowTertiary: '0 1px 2px rgba(33, 31, 28, 0.04)'
}

const NEUTRALS_DARK = {
  colorTextBase: '#F0EDE6',
  colorBgLayout: '#161513',
  colorBgContainer: '#1F1E1B',
  colorBgElevated: '#2A2825',
  colorBorder: '#45423B',
  colorBorderSecondary: '#322F2A',
  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.4), 0 4px 12px rgba(0, 0, 0, 0.5)',
  boxShadowSecondary: '0 3px 6px rgba(0, 0, 0, 0.5), 0 8px 24px rgba(0, 0, 0, 0.6)',
  boxShadowTertiary: '0 1px 2px rgba(0, 0, 0, 0.35)'
}

/**
 * 一套完整令牌:海拔与中性色按明暗取,强调色由用户选(明度按模式钳位)。
 *
 * colorSuccess / Warning / Error 一律不动,保持 antd 默认:上下文占用环在 16px 的环上同时
 * 画 primary / warning / error 三态。开放自定义强调色的代价就在这里 —— 用户挑一个和橙色
 * 相近的颜色,告警态就跟着一起变;没有加运行时提示,因为默认的虎橙(h≈17°)本来就夹在
 * error(0°)与 warning(40°)中间,任何「色相相近就提示」的规则都会把默认值也标出来。
 */
export function buildTheme(isDark: boolean, accentHex: string): AppTheme {
  const accent = deriveAccent(accentHex, isDark)
  const glowAlpha = isDark ? 0.16 : 0.12
  return {
    algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      ...sharedToken,
      ...(isDark ? NEUTRALS_DARK : NEUTRALS_LIGHT),
      colorPrimary: accent,
      colorInfo: accent
    },
    components: {
      Button: {
        fontWeight: 500,
        defaultShadow: 'none',
        primaryShadow: 'none',
        dangerShadow: 'none',
        // 暗色下强调色被调亮后托不住白字,所以文字色跟着实际发出去的那个颜色算
        primaryColor: readableInk(accent)
      },
      Input: { activeShadow: `0 0 0 3px ${withAlpha(accent, glowAlpha)}` },
      Select: { activeOutlineColor: withAlpha(accent, glowAlpha) },
      Modal: {
        headerBg: 'transparent',
        titleFontSize: 16,
        contentBg: isDark ? '#2A2825' : '#FFFFFF'
      },
      Tag: {
        defaultBg: withAlpha(isDark ? '#F0EDE6' : '#211F1C', isDark ? 0.08 : 0.05),
        defaultColor: isDark ? '#B9B4AA' : '#5F5C56'
      }
    }
  }
}
