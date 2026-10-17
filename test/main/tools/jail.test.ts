import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeTempDir, removeTempDir, writeFiles } from '../../helpers/temp'
import { confine, confinement, resolveDeep } from '../../../src/main/tools/jail'

/**
 * 路径 jail 的判定层。
 *
 * 这里测的是「判得对不对」,不是「拒得狠不狠」:jail 判错的两种形态(界内判成界外、
 * 界外判成界内)都是静默的,前者让模型写不进自己的工作目录,后者等于没有护栏。
 * 临时目录一律先 `realpathSync` 一遍再当根用 —— mac 上 `os.tmpdir()` 落在 `/var`
 * 这层软链下面,不解就会让每条断言都变成"根与目标不在同一间屋子"。
 */

let tmp: string
/** 已经解成真身的工作空间根:所有 case 的 `realRoot` 都用它 */
let root: string

beforeEach(() => {
  tmp = fs.realpathSync(makeTempDir())
  root = path.join(tmp, 'workspace')
  fs.mkdirSync(root)
})

afterEach(() => {
  removeTempDir(tmp)
})

describe('退到存在的祖先', () => {
  it('目标不存在也必须能解:新建文件的路径退到最近的已存在祖先,而不是 ENOENT 就放弃', () => {
    const target = path.join(root, 'notes/todo/2026.md')
    expect(resolveDeep(target)).toBe(target)
    expect(confine(target, root)).toBe(target)
  })

  it('字形上的 .. 先折再用:根内的 alias/../b 落在根内,不该因为 alias 是软链就被拒', () => {
    fs.mkdirSync(path.join(root, 'data'))
    fs.symlinkSync(path.join(root, 'data'), path.join(root, 'alias'), 'dir')
    const target = path.join(root, 'alias/../b.txt')
    const result = confinement(target, root)
    expect(result.inside).toBe(true)
    // alias 指向的是同一个根内的目录,折完 `..` 就回到根;写的是 b.txt,不是 alias 里头
    expect(result.real).toBe(path.join(root, 'b.txt'))
  })

  it('.. 紧跟在软链后面时先在字形上折掉:realpath 对这儿的处理 mac 与 linux 不一致,判定不能跟着平台变', () => {
    writeFiles(tmp, {
      'elsewhere/inner/keep.txt': '外面的目录',
      'elsewhere/secret.txt': '外面的文件'
    })
    fs.symlinkSync(path.join(tmp, 'elsewhere/inner'), path.join(root, 'escape'), 'dir')
    const target = path.join(root, 'escape/../secret.txt')
    // 内核视角(把字形原样交给 open)会跟完软链再退一层,落在根外
    const kernelView = path.join(tmp, 'elsewhere/secret.txt')
    // 半套一(只 realpath):新建目标必然 ENOENT,一报错就放弃判定
    expect(() => fs.realpathSync(target)).toThrow()
    // 全套:先折掉 `..`,于是解出的是根内那条,而调用方 open 的就是这条
    const result = confinement(target, root)
    expect(result.inside).toBe(true)
    expect(result.real).toBe(path.join(root, 'secret.txt'))
    expect(result.real).not.toBe(kernelView)
  })

  it('纯文本就能判出的 .. 越界不依赖软链', () => {
    expect(confinement(path.join(root, '../../etc/passwd'), root).inside).toBe(false)
    expect(() => confine(path.join(root, '../outside.txt'), root)).toThrow()
  })

  it('中段是一个已存在的文件:不报界外,把 ENOTDIR 交给 fs 去说准确', () => {
    writeFiles(root, { 'plain.txt': '我不是目录' })
    const target = path.join(root, 'plain.txt/inside.txt')
    const result = confinement(target, root)
    expect(result.inside).toBe(true)
    expect(result.real).toBe(target)
  })
})

describe('根自身是软链', () => {
  it('根与目标各自解成真身后才算同一间屋子:不解就把根内的路径判成越界', () => {
    const linkRoot = path.join(tmp, 'workspace-link')
    fs.symlinkSync(root, linkRoot, 'dir')
    const target = path.join(root, 'notes.md')
    // 直接拿没解过的软链根去判:同一间屋子被认成两间,界内的写入被误伤
    expect(confinement(target, linkRoot).inside).toBe(false)
    // 解过之后判对,返回的就是目标自己的真身
    expect(confine(target, fs.realpathSync(linkRoot))).toBe(target)
  })

  it('root 交给 confine 之前必定是 realpath:由 jailFor 那一层负责,判层不再兜', () => {
    const linkRoot = path.join(tmp, 'workspace-link')
    fs.symlinkSync(root, linkRoot, 'dir')
    const result = confinement(path.join(root, 'notes.md'), linkRoot)
    // 判层只解 target 的真身,根那侧原样使用 —— 兜了就会让每条写入多一次 IO
    expect(result.real).toBe(path.join(root, 'notes.md'))
    expect(fs.realpathSync(linkRoot)).toBe(root)
  })

  it('根为空时不抛:没有根就没有 jail,由调用方决定退回标注模式', () => {
    // 未选工作空间那一支靠的就是"jailFor 不给根";万一哪天误传了空串,
    // 判定层也不该反过来把所有写入都拒掉
    const elsewhere = path.join(tmp, 'not-the-root/x.txt')
    expect(confinement(elsewhere, '').inside).toBe(true)
    expect(confine(elsewhere, '')).toBe(elsewhere)
  })
})

describe('confine:出界就抛', () => {
  it('根内的写入返回解出来的真路径,而不是模型给的那条字形', () => {
    fs.mkdirSync(path.join(root, 'data'))
    fs.symlinkSync(path.join(root, 'data'), path.join(root, 'alias'), 'dir')
    const literal = path.join(root, 'alias/nested/deep.txt')
    expect(confine(literal, root)).toBe(path.join(root, 'data/nested/deep.txt'))
  })

  it('指向家目录的绝对路径被拒', () => {
    expect(() => confine(path.join(os.homedir(), 'x.txt'), root)).toThrow('之外,本次写入未执行')
  })

  it('工作空间里预先存在的软链指向根外时被拒', () => {
    writeFiles(tmp, { 'outside-secret/id_rsa': '机密' })
    fs.symlinkSync(path.join(tmp, 'outside-secret'), path.join(root, 'keys'), 'dir')
    expect(() => confine(path.join(root, 'keys/id_rsa'), root)).toThrow()
  })

  it('拒绝的话是陈述句、说清根在哪儿,且不含「请改用 / 务必」这类祈使', () => {
    const target = path.join(os.homedir(), 'x.txt')
    let message = ''
    try {
      confine(target, root)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain(target)
    expect(message).toContain(root)
    expect(message).toContain('未执行')
    expect(message).not.toMatch(/请|务必|必须|应该|不要|换用|改用/)
  })
})
