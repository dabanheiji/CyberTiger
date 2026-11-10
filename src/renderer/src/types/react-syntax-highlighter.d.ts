/**
 * react-syntax-highlighter 没有随包 TypeScript 声明,这里只补我们用到的几处:
 * 两个 Prism 主题、PrismLight 实例,以及按语言拆分的语法包。
 * 主题导出的是「CSS 选择器 → 样式对象」的普通字典,SyntaxHighlighter 直接消费。
 */
declare module 'react-syntax-highlighter/dist/esm/styles/prism/one-light' {
  import type { CSSProperties } from 'react'
  const style: Record<string, CSSProperties>
  export default style
}

declare module 'react-syntax-highlighter/dist/esm/styles/prism/one-dark' {
  import type { CSSProperties } from 'react'
  const style: Record<string, CSSProperties>
  export default style
}

declare module 'react-syntax-highlighter/dist/esm/languages/prism/*.js' {
  /** refractor 语法:注册时由它把规则挂到 Prism 实例上 */
  const grammar: (prism: unknown) => void
  export default grammar
}

declare module 'react-syntax-highlighter/dist/esm/prism-light.js' {
  import type { ComponentType } from 'react'

  interface PrismLightComponent extends ComponentType<Record<string, unknown>> {
    /** 第一个参数被实现忽略,语法按自身的 displayName 注册 */
    registerLanguage(name: string, grammar: (prism: unknown) => void): void
  }

  const PrismLight: PrismLightComponent
  export default PrismLight
}
