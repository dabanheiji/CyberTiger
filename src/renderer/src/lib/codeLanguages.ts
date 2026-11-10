import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash.js'
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c.js'
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp.js'
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp.js'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css.js'
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff.js'
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker.js'
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go.js'
import graphql from 'react-syntax-highlighter/dist/esm/languages/prism/graphql.js'
import http from 'react-syntax-highlighter/dist/esm/languages/prism/http.js'
import ini from 'react-syntax-highlighter/dist/esm/languages/prism/ini.js'
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java.js'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript.js'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json.js'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx.js'
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin.js'
import less from 'react-syntax-highlighter/dist/esm/languages/prism/less.js'
import lua from 'react-syntax-highlighter/dist/esm/languages/prism/lua.js'
import makefile from 'react-syntax-highlighter/dist/esm/languages/prism/makefile.js'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown.js'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup.js'
import nginx from 'react-syntax-highlighter/dist/esm/languages/prism/nginx.js'
import objectivec from 'react-syntax-highlighter/dist/esm/languages/prism/objectivec.js'
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php.js'
import powershell from 'react-syntax-highlighter/dist/esm/languages/prism/powershell.js'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python.js'
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby.js'
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust.js'
import sass from 'react-syntax-highlighter/dist/esm/languages/prism/sass.js'
import scss from 'react-syntax-highlighter/dist/esm/languages/prism/scss.js'
import shellSession from 'react-syntax-highlighter/dist/esm/languages/prism/shell-session.js'
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql.js'
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift.js'
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml.js'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx.js'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript.js'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml.js'
import PrismLight from 'react-syntax-highlighter/dist/esm/prism-light.js'

/**
 * 常用语法在模块加载时就注册进 PrismLight。
 *
 * CodeHighlighter 自带的语言包按需加载写的是 `import(...prism/${lang})`,打包器不会分析
 * node_modules 里的这种计算式动态导入 —— 产物里它仍是裸模块名,渲染层解析不到,异常被组件
 * 内部吞掉后高亮静默退回纯文本。预注册之后渲染走的是同一个 PrismLight 实例,不再依赖那次
 * 动态导入;语法本身作为普通静态导入随主 chunk 一起打包。
 */
const GRAMMARS: Array<(prism: unknown) => void> = [
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  docker,
  go,
  graphql,
  http,
  ini,
  java,
  javascript,
  json,
  jsx,
  kotlin,
  less,
  lua,
  makefile,
  markdown,
  markup,
  nginx,
  objectivec,
  php,
  powershell,
  python,
  ruby,
  rust,
  sass,
  scss,
  shellSession,
  sql,
  swift,
  toml,
  tsx,
  typescript,
  yaml
]

for (const grammar of GRAMMARS) {
  // RSH 的实现忽略第一个参数,语法按自身 displayName 注册
  PrismLight.registerLanguage('', grammar)
}
