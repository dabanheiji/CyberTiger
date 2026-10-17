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

/** #RRGGBB → rgba()。淡染与光晕都要在强调色上取透明,颜色字面量只该出现在本文件 */
export function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16)
  const r = (value >> 16) & 0xff
  const g = (value >> 8) & 0xff
  const b = value & 0xff
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * 强调色(虎橙)。浅色 #D9480F 对白底 4.9:1 过 AA;深色下要更亮才够对比,换成 #FF922B,
 * 代价是它托不住白字,所以主按钮的文字色单独压深(见 darkTheme.components.Button)。
 * 只设 colorPrimary 这一个 seed,hover / active / bg / border 交给 algorithm 派生。
 */
const ACCENT_LIGHT = '#D9480F'
const ACCENT_DARK = '#FF922B'

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
 * 浅色。三级海拔:侧栏与外框 colorBgLayout(暖纸,凹陷)→ 聊天画布 colorBgContainer
 * → 浮层 colorBgElevated + 阴影。层次靠背景差与阴影,不再靠 1px 边框。
 * colorSuccess / Warning / Error 保持 antd 默认:上下文占用环在 16px 的环上同时画
 * primary / warning / error 三态,重调它们只会让三态难以区分。
 */
export const lightTheme: AppTheme = {
  algorithm: theme.defaultAlgorithm,
  token: {
    ...sharedToken,
    colorPrimary: ACCENT_LIGHT,
    colorInfo: ACCENT_LIGHT,
    colorTextBase: '#211F1C',
    colorBgLayout: '#F5F4F1',
    colorBgContainer: '#FFFFFF',
    colorBgElevated: '#FFFFFF',
    colorBorder: '#D8D5CF',
    colorBorderSecondary: '#EBE9E4',
    boxShadow: '0 1px 2px rgba(33, 31, 28, 0.05), 0 4px 12px rgba(33, 31, 28, 0.08)',
    boxShadowSecondary: '0 3px 6px rgba(33, 31, 28, 0.08), 0 8px 24px rgba(33, 31, 28, 0.1)',
    boxShadowTertiary: '0 1px 2px rgba(33, 31, 28, 0.04)'
  },
  components: {
    Button: {
      fontWeight: 500,
      defaultShadow: 'none',
      primaryShadow: 'none',
      dangerShadow: 'none'
    },
    Input: { activeShadow: `0 0 0 3px ${withAlpha(ACCENT_LIGHT, 0.12)}` },
    Select: { activeOutlineColor: withAlpha(ACCENT_LIGHT, 0.12) },
    Modal: { headerBg: 'transparent', titleFontSize: 16, contentBg: '#FFFFFF' },
    Tag: { defaultBg: withAlpha('#211F1C', 0.05), defaultColor: '#5F5C56' }
  }
}

/**
 * 深色。darkAlgorithm 给的是接近纯黑的冷调(colorBgLayout ≈ #000),做不出三级海拔,
 * 所以三档背景都自己指定成暖色,海拔由背景差承担,阴影只负责再压深一点。
 */
export const darkTheme: AppTheme = {
  algorithm: theme.darkAlgorithm,
  token: {
    ...sharedToken,
    colorPrimary: ACCENT_DARK,
    colorInfo: ACCENT_DARK,
    colorTextBase: '#F0EDE6',
    colorBgLayout: '#161513',
    colorBgContainer: '#1F1E1B',
    colorBgElevated: '#2A2825',
    colorBorder: '#45423B',
    colorBorderSecondary: '#322F2A',
    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.4), 0 4px 12px rgba(0, 0, 0, 0.5)',
    boxShadowSecondary: '0 3px 6px rgba(0, 0, 0, 0.5), 0 8px 24px rgba(0, 0, 0, 0.6)',
    boxShadowTertiary: '0 1px 2px rgba(0, 0, 0, 0.35)'
  },
  components: {
    Button: {
      fontWeight: 500,
      defaultShadow: 'none',
      primaryShadow: 'none',
      dangerShadow: 'none',
      primaryColor: '#1F1305'
    },
    Input: { activeShadow: `0 0 0 3px ${withAlpha(ACCENT_DARK, 0.16)}` },
    Select: { activeOutlineColor: withAlpha(ACCENT_DARK, 0.16) },
    Modal: { headerBg: 'transparent', titleFontSize: 16, contentBg: '#2A2825' },
    Tag: { defaultBg: withAlpha('#F0EDE6', 0.08), defaultColor: '#B9B4AA' }
  }
}
