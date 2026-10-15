import os from 'node:os'
import path from 'node:path'
import {
  annotate,
  anchor,
  describeFsError,
  expandHome,
  statIfExists
} from '../../../src/main/tools/paths'

// /ws 只是纯文本上的基准:anchor 与 annotate 都不碰文件系统,不必真造一个目录
const WS = path.join(path.sep, 'ws')

describe('expandHome', () => {
  it('把 ~ 与 ~/ 前缀换成家目录:路径不经过 shell,自动展开不会发生', () => {
    expect(expandHome('~')).toBe(os.homedir())
    expect(expandHome('~/Desktop/notes.md')).toBe(path.join(os.homedir(), 'Desktop/notes.md'))
  })

  it('只认开头的 ~:~backup/x 是一个真实目录名,不能当成家目录', () => {
    expect(expandHome('~backup/x')).toBe('~backup/x')
    expect(expandHome('/tmp/~/x')).toBe('/tmp/~/x')
  })
})

describe('anchor', () => {
  it('相对路径落在工作空间里,不算越界', () => {
    expect(anchor('src/a.ts', WS)).toEqual({ path: path.join(WS, 'src/a.ts'), outside: false })
  })

  it('工作空间本身视为内部:相对 . 解析出来就是它,不该标成越界', () => {
    expect(anchor('.', WS).outside).toBe(false)
    expect(anchor('', WS).path).toBe(WS)
  })

  it('绝对路径原样保留,越界判定看它是不是在工作空间子树内', () => {
    expect(anchor(path.join(WS, 'notes.md'), WS)).toEqual({
      path: path.join(WS, 'notes.md'),
      outside: false
    })
    expect(anchor(path.join(path.sep, 'etc', 'hosts'), WS).outside).toBe(true)
    // 同级目录不是子目录:../ 开头即越界(兄弟节点是最容易被误放行的一类)
    expect(anchor(path.join(path.sep, 'other', 'a.txt'), WS).outside).toBe(true)
  })

  it('~ 前缀优先于工作空间:家目录在 /ws 之外就是在外面,而不是拼到工作空间下', () => {
    const anchored = anchor('~/notes.md', WS)
    expect(anchored.path).toBe(path.join(os.homedir(), 'notes.md'))
    // 家目录恰好是 /ws 子目录的情况在本机不成立,所以断言只在结构上说清优先级
    expect(anchored.outside).toBe(!anchored.path.startsWith(WS + path.sep))
  })

  it('没选工作空间时退回应用当前目录,并且一律不标越界', () => {
    // 语义 3:未选 = 加这列之前的行为。基准点是碰巧的进程目录,标"越界"会误导模型
    expect(anchor('a/b.txt', '')).toEqual({
      path: path.resolve(process.cwd(), 'a/b.txt'),
      outside: false
    })
    expect(anchor(path.join(path.sep, 'etc', 'hosts'), '').outside).toBe(false)
  })

  it('带空格的路径先 trim 再锚定,模型抄来的路径尾部的空格不该进文件名', () => {
    expect(anchor('  notes.md  ', WS).path).toBe(path.join(WS, 'notes.md'))
  })
})

describe('annotate', () => {
  it('越界时在结果末尾补一句绝对路径与工作空间:允许访问,但要把话说清', () => {
    const target = anchor(path.join(path.sep, 'etc', 'hosts'), WS)
    const text = annotate('exit_code: 0', target, WS)
    expect(text).toContain('exit_code: 0')
    expect(text).toContain('在本次会话的工作空间')
    expect(text).toContain('/etc/hosts')
  })

  it('没越界时正文一字不动:正常路径不该被附上一句无关的提醒', () => {
    expect(annotate('已写入 12 B', anchor('a.txt', WS), WS)).toBe('已写入 12 B')
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
