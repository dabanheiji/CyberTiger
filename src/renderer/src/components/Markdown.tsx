import { CodeHighlighter } from '@ant-design/x'
import XMarkdown, { type ComponentProps } from '@ant-design/x-markdown'
import { theme } from 'antd'
import { createContext, useContext, useMemo } from 'react'
import type { CSSProperties } from 'react'
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark'
import oneLight from 'react-syntax-highlighter/dist/esm/styles/prism/one-light'
import { useSystemTheme } from '../hooks/useSystemTheme'
import '../lib/codeLanguages'
import { markdownVars, normalizeCodeLang } from '../lib/markdownTheme'

interface MarkdownProps {
  content: string
}

interface CodeTheme {
  /** Prism 主题对象;每侧只建一次,代码块共用同一份引用 */
  highlight: Record<string, CSSProperties>
}

const CodeThemeContext = createContext<CodeTheme | null>(null)

/** 代码子节点理论上就是一段文本;拼成字符串是因为高亮器只收 string */
function nodeText(children: React.ReactNode): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map(nodeText).join('')
  return ''
}

/**
 * Prism 的 oneLight / oneDark 自带底色、内外边距与字体,这里只改与容器冲突的几项:
 * 底色交给 CodeHighlighter 自己的容器(取 antd 令牌,随明暗与强调色走),
 * 外边距清零、圆角交给容器,字体与正文等宽带对齐。
 */
function highlightStyle(isDark: boolean, fontFamilyCode: string): Record<string, CSSProperties> {
  const base = isDark ? oneDark : oneLight
  return {
    ...base,
    'pre[class*="language-"]': {
      ...base['pre[class*="language-"]'],
      background: 'transparent',
      margin: 0,
      borderRadius: 0,
      padding: '12px 16px',
      fontFamily: fontFamilyCode
    },
    'code[class*="language-"]': {
      ...base['code[class*="language-"]'],
      fontFamily: fontFamilyCode
    }
  }
}

function CodeBlock(props: ComponentProps): React.JSX.Element {
  const codeTheme = useContext(CodeThemeContext)
  const text = nodeText(props.children)
  const lang = normalizeCodeLang(props.lang)

  // 行内代码、没有语言、写明是纯文本,以及流式中的半截代码块都按普通 code 渲染:
  // 前半段交给官方主题的块级样式(底色、内边距、圆角),流式时则避免每个 delta 重跑高亮。
  if (!props.block || props.streamStatus === 'loading' || !lang || !text) {
    return <code className={props.className}>{props.children}</code>
  }

  return (
    <CodeHighlighter
      lang={lang}
      highlightProps={codeTheme ? { style: codeTheme.highlight } : undefined}
    >
      {text}
    </CodeHighlighter>
  )
}

const MARKDOWN_COMPONENTS = { code: CodeBlock }

/**
 * 全应用唯一的 Markdown 渲染入口:用户消息、AI 正文、计划预览共用。
 *
 * 官方主题(x-markdown-light / dark)负责结构 —— 标题层级、列表、表格、引用、代码块;
 * 颜色由内联 CSS 变量覆盖成应用令牌,链接因此跟随用户强调色,其余取暖色中性色。
 * 明暗切换与自定义强调色不需要为 Markdown 再写一套配色。
 *
 * disableDefaultStyles 只放行 pre / code:组件自带基础样式对这两个标签的规则
 * 优先级更高(三个类 > 主题的两个类),会把主题给的 padding、圆角与 margin 清零,
 * 代码块于是紧贴背景。其余标签仍走基础样式,保留它更紧凑的间距与宽表格横滚。
 *
 * 代码高亮走 CodeHighlighter(官方配套组件),常用语法由 lib/codeLanguages 在模块加载时
 * 预注册进同一个 PrismLight —— 它自带的按需加载用计算式动态 import,打包后在应用里解析
 * 不到,不预注册就只能退回纯文本。高亮配色另走 context 下发,不用每个代码块各自订阅明暗,
 * 也免得组件在渲染期被重建。
 */
function Markdown({ content }: MarkdownProps): React.JSX.Element {
  const { token } = theme.useToken()
  const isDark = useSystemTheme()
  const vars = useMemo(() => markdownVars(token, isDark), [token, isDark])
  const codeTheme = useMemo<CodeTheme>(
    () => ({ highlight: highlightStyle(isDark, token.fontFamilyCode) }),
    [isDark, token.fontFamilyCode]
  )

  return (
    <CodeThemeContext.Provider value={codeTheme}>
      <XMarkdown
        content={content}
        className={isDark ? 'x-markdown-dark' : 'x-markdown-light'}
        style={vars}
        components={MARKDOWN_COMPONENTS}
        disableDefaultStyles={['pre', 'code']}
      />
    </CodeThemeContext.Provider>
  )
}

export default Markdown
