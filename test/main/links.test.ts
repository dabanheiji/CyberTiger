import { externalLinkFor, isAppDocument } from '../../src/main/links'

/**
 * 外链判定是「窗口不被导航走」的唯一一道闸门。判宽了会把危险协议交给系统,
 * 判窄了连应用自己的刷新都拦下 —— 两侧各钉一组。
 */
describe('externalLinkFor', () => {
  it('http / https / mailto 原样交给系统浏览器', () => {
    expect(externalLinkFor('http://localhost:3000/')).toBe('http://localhost:3000/')
    expect(externalLinkFor('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c')
    expect(externalLinkFor('mailto:someone@example.com')).toBe('mailto:someone@example.com')
  })

  it('危险协议与解析不了的地址一律不外开', () => {
    expect(externalLinkFor('file:///etc/passwd')).toBeNull()
    expect(externalLinkFor('javascript:alert(1)')).toBeNull()
    expect(externalLinkFor('data:text/html,hi')).toBeNull()
    expect(externalLinkFor('slack://channel?id=1')).toBeNull()
    expect(externalLinkFor('./relative/path')).toBeNull()
    expect(externalLinkFor('')).toBeNull()
  })
})

describe('isAppDocument', () => {
  const prod = 'file:///Applications/CyberTiger.app/out/renderer/index.html'

  it('打包后只认 renderer/index.html 这一份文档,哈希与 query 不算换文档', () => {
    expect(isAppDocument(prod, prod)).toBe(true)
    expect(isAppDocument(`${prod}#/settings`, prod)).toBe(true)
    expect(isAppDocument(`${prod}?v=1`, prod)).toBe(true)
    expect(isAppDocument('file:///Applications/CyberTiger.app/out/renderer/other.html', prod)).toBe(
      false
    )
    expect(isAppDocument('file:///etc/passwd', prod)).toBe(false)
  })

  it('开发时只认同源同路径,别的站点与外链都不是应用自己', () => {
    const dev = 'http://localhost:5173'
    expect(isAppDocument('http://localhost:5173/', dev)).toBe(true)
    expect(isAppDocument('http://localhost:5173/#/chat', dev)).toBe(true)
    expect(isAppDocument('http://localhost:3000/', dev)).toBe(false)
    expect(isAppDocument('https://localhost:5173/', dev)).toBe(false)
    expect(isAppDocument('http://localhost:5173/other', dev)).toBe(false)
  })

  it('解析不了的地址不算应用自己', () => {
    expect(isAppDocument('not a url', prod)).toBe(false)
  })
})
