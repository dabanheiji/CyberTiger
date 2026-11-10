import { Backlog } from '../../../src/main/terminal/backlog'

describe('Backlog', () => {
  it('没到上限时按写入顺序原样读回', () => {
    const backlog = new Backlog(100)
    backlog.append('a')
    backlog.append('bc')
    expect(backlog.toString()).toBe('abc')
    expect(backlog.length).toBe(3)
  })

  it('超过上限从头部裁掉最旧的部分:回放要的是最近一屏,不是整段历史', () => {
    const backlog = new Backlog(5)
    backlog.append('abc')
    backlog.append('defg')
    expect(backlog.toString()).toBe('cdefg')
    expect(backlog.length).toBe(5)
  })

  it('裁剪点落在代理对中间时往后让一个字符:回放不该从半个 emoji 开始', () => {
    const backlog = new Backlog(3)
    // "a😀bc" 共 5 个 code unit,上限 3 会把切口落在 😀 的低位代理上
    backlog.append('a😀bc')
    const text = backlog.toString()
    const first = text.charCodeAt(0)
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false)
    expect(text.length).toBeLessThanOrEqual(3)
    expect(text.endsWith('bc')).toBe(true)
  })

  it('空 chunk 不改变内容:node-pty 偶尔会给空字符串', () => {
    const backlog = new Backlog(10)
    backlog.append('')
    backlog.append('a')
    expect(backlog.toString()).toBe('a')
  })
})
