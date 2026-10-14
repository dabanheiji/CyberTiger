import os from 'node:os'
import path from 'node:path'
import {
  describeFsError,
  expandHome,
  resolvePath,
  statIfExists
} from '../../../src/main/tools/paths'

describe('expandHome', () => {
  it('把 ~ 与 ~/ 前缀换成家目录:路径不经过 shell,自动展开不会发生', () => {
    expect(expandHome('~')).toBe(os.homedir())
    expect(expandHome('~/Desktop/notes.md')).toBe(path.join(os.homedir(), 'Desktop/notes.md'))
  })

  it('只认开头的 ~:~backup/x 是一个真实目录名,不能当成家目录', () => {
    expect(expandHome('~backup/x')).toBe('~backup/x')
    expect(expandHome('/tmp/~/x')).toBe('/tmp/~/x')
  })

  it('解析结果是绝对路径,相对路径落在调用方当前目录', () => {
    const resolved = resolvePath('a/b.txt')
    expect(path.isAbsolute(resolved)).toBe(true)
    expect(resolved).toBe(path.resolve('a/b.txt'))
  })
})

describe('describeFsError', () => {
  it('认得的错误码翻成一句能照着改的中文,并保留原始 message 里的路径', () => {
    const error = Object.assign(new Error("ENOENT: no such file, open '/x/y.txt'"), {
      code: 'ENOENT'
    })
    expect(describeFsError(error)).toContain('路径不存在')
    expect(describeFsError(error)).toContain('/x/y.txt')
  })

  it('没见过的错误码退回原始 message,不编造解释', () => {
    const error = Object.assign(new Error('disk on fire'), { code: 'EXOTIC' })
    expect(describeFsError(error)).toBe('disk on fire')
  })
})

describe('statIfExists', () => {
  it('路径不存在或中段不是目录时给 undefined,让真正的读写去报准确错误', async () => {
    expect(await statIfExists(path.join(os.tmpdir(), 'cybertiger-no-such-path-x'))).toBeUndefined()
    expect(await statIfExists(`${os.homedir()}/../nonexistent-deep/x`)).toBeUndefined()
  })

  it('目录本身也算存在', async () => {
    expect((await statIfExists(os.tmpdir()))?.isDirectory()).toBe(true)
  })
})
