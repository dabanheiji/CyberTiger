import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import PrismLight from 'react-syntax-highlighter/dist/esm/prism-light.js'
import { refractor } from 'refractor/core'
import { describe, expect, it } from 'vitest'
import '../../../src/renderer/src/lib/codeLanguages'
import { normalizeCodeLang } from '../../../src/renderer/src/lib/markdownTheme'

/** 每种语言配一段必然会切出 token 的代码;渲染结果里没有 span 就说明退回了纯文本 */
const SAMPLES: Record<string, string> = {
  bash: 'echo "$HOME"',
  c: 'int main() {}',
  cpp: 'int main() {}',
  csharp: 'class A {}',
  css: 'a { color: red }',
  diff: '- a\n+ b',
  docker: 'FROM node:22',
  go: 'package main',
  graphql: 'type Query { a: Int }',
  http: 'GET / HTTP/1.1',
  ini: '[section]\nkey = 1',
  java: 'class A {}',
  javascript: 'const x = 1',
  json: '{"a": 1}',
  jsx: 'const A = () => <div />',
  kotlin: 'fun main() {}',
  less: '@x: 1px;',
  lua: 'local x = 1',
  makefile: 'all:\n\techo hi',
  markdown: '# title',
  markup: '<p class="x">hi</p>',
  nginx: 'server { listen 80; }',
  objectivec: 'int main() { return 0; }',
  php: '<?php echo 1; ?>',
  powershell: 'Write-Host hi',
  python: 'print(1)',
  ruby: 'puts 1',
  rust: 'fn main() {}',
  sass: 'a\n  color: red',
  scss: 'a { color: red; }',
  'shell-session': '$ echo hi',
  sql: 'select * from t',
  swift: 'let x = 1',
  toml: 'a = 1',
  tsx: 'const A = () => <div />',
  typescript: 'const x: number = 1',
  yaml: 'key: value'
}

describe('codeLanguages', () => {
  it('常用语法在模块加载时就注册好了,不依赖运行时的语言包加载', () => {
    for (const lang of Object.keys(SAMPLES)) {
      expect(refractor.registered(lang), lang).toBe(true)
    }
  })

  it('注册过的语法能真正切出高亮节点,而不是退回纯文本', () => {
    for (const [lang, code] of Object.entries(SAMPLES)) {
      const html = renderToStaticMarkup(createElement(PrismLight, { language: lang }, code))
      expect(html, lang).toContain('token')
    }
  })

  it('归一后的常见别名都落在已注册的集合里', () => {
    const aliases = [
      'js',
      'ts',
      'sh',
      'shell',
      'shellscript',
      'zsh',
      'console',
      'terminal',
      'py',
      'yml',
      'md',
      'html',
      'xml',
      'htm',
      'dockerfile',
      'cs',
      'rb',
      'rs',
      'kt',
      'golang',
      'ps1'
    ]
    for (const raw of aliases) {
      const lang = normalizeCodeLang(raw)
      expect(lang, raw).toBeTruthy()
      expect(refractor.registered(lang as string), raw).toBe(true)
    }
  })
})
