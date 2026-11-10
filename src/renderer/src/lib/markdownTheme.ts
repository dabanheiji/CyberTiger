import type { GlobalToken } from 'antd'
import type { CSSProperties } from 'react'

/**
 * Markdown 主题只关心颜色与圆角这几项。窄接口让单测不必造一份完整 token,
 * 也让「哪些令牌真的用上了」在类型里一眼可见。
 */
export type MarkdownPalette = Pick<
  GlobalToken,
  | 'colorPrimary'
  | 'colorPrimaryHover'
  | 'colorTextHeading'
  | 'colorText'
  | 'colorBorderSecondary'
  | 'colorSplit'
  | 'colorFillTertiary'
  | 'colorFillQuaternary'
  | 'colorBgContainer'
  | 'borderRadius'
  | 'borderRadiusSM'
  | 'fontSize'
>

/** React 的 CSSProperties 不收自定义属性,单独补一层模板字面量的索引签名 */
export type MarkdownStyle = CSSProperties & Record<`--${string}`, string>

/**
 * 把应用令牌翻译成官方 @ant-design/x-markdown 主题的那组 CSS 变量。
 *
 * 官方主题(light.css / dark.css)负责排版结构,取色全走变量;这里覆盖变量的值,
 * 于是链接跟随用户强调色、正文与描边沿用暖色中性色,而不是官方那套蓝链接与纯黑白。
 *
 * 两套主题的代码块背景变量名不同(浅色 `--light-bg`、暗色 `--dark-bg`),
 * 所以只写当前那一侧需要的那个,另一侧的名字干脆不出现 —— 写错一个就是静默丢底色。
 */
export function markdownVars(palette: MarkdownPalette, isDark: boolean): MarkdownStyle {
  const vars: MarkdownStyle = {
    '--font-size': `${palette.fontSize}px`,
    '--primary-color': palette.colorPrimary,
    '--primary-color-hover': palette.colorPrimaryHover,
    '--heading-color': palette.colorTextHeading,
    '--text-color': palette.colorText,
    '--border-color': palette.colorBorderSecondary,
    '--line-color': palette.colorSplit,
    '--table-head-bg': palette.colorFillQuaternary,
    '--table-body-bg': palette.colorBgContainer,
    '--cite-bg': palette.colorFillQuaternary,
    '--cite-hover-bg': palette.colorFillTertiary,
    '--border-radius-middle': `${palette.borderRadius}px`,
    '--border-radius-small': `${palette.borderRadiusSM}px`
  }
  vars[isDark ? '--dark-bg' : '--light-bg'] = palette.colorFillTertiary
  return vars
}

/** 模型常写的短名 → Prism 的规范语言名;统一之后标题显示与「认不认得」都稳定 */
const CODE_LANG_ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  sh: 'bash',
  shell: 'bash',
  shellscript: 'bash',
  zsh: 'bash',
  console: 'shell-session',
  terminal: 'shell-session',
  py: 'python',
  yml: 'yaml',
  md: 'markdown',
  html: 'markup',
  xml: 'markup',
  htm: 'markup',
  dockerfile: 'docker',
  cs: 'csharp',
  rb: 'ruby',
  rs: 'rust',
  kt: 'kotlin',
  golang: 'go',
  ps1: 'powershell'
}

/** 这些写法没有语法可高亮,按普通代码块渲染 */
const PLAIN_LANGS = new Set(['text', 'plaintext', 'plain', 'txt', 'none', 'raw'])

/**
 * 把围栏的 info string 收敛成高亮器能用的语言名。
 *
 * info string 可能带参数(`ts title=foo`),只取第一个词;大小写不敏感。
 * 返回 undefined 表示「按普通代码块渲染」——没有语言,或者写明是纯文本。
 * 不做白名单:未知语言原样交给 Prism,它认不出时会退回纯文本而不是报错,
 * 代码照常可读,比在这里维护一份注定漏项的语言清单稳。
 */
export function normalizeCodeLang(lang?: string): string | undefined {
  const first = lang?.trim().split(/\s+/)[0]?.toLowerCase()
  if (!first || PLAIN_LANGS.has(first)) return undefined
  return CODE_LANG_ALIASES[first] ?? first
}
