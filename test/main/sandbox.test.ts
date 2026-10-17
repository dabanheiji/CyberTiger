import fs from 'node:fs'
import path from 'node:path'
import { jailFor } from '../../src/main/sandbox'
import { makeTempDir, removeTempDir, writeFiles } from '../helpers/temp'

/**
 * 「jail 开不开」这条规则。
 *
 * 判定层（`tools/jail.ts`）只管给定根之后对不对,这一层管的是**有没有根**——
 * 它最容易出错的两种形态都不会报错:该 jail 时返回了 `undefined`（等于护栏没装）,
 * 以及建不出根时静默退回无边界继续跑（用户以为被挡住了）。
 */

let tmp: string

beforeEach(() => {
  tmp = makeTempDir()
})

afterEach(() => {
  removeTempDir(tmp)
})

describe('缺省即开', () => {
  it('老用户的配置里没有 sandbox 这一键时 jail 是开的:缺键与「显式最严」同一个意思', () => {
    const dir = path.join(tmp, 'workspace')
    fs.mkdirSync(dir)
    expect(jailFor(undefined, dir)?.root).toBe(fs.realpathSync(dir))
    expect(jailFor({}, dir)?.root).toBe(fs.realpathSync(dir))
  })

  it('设置页把开关推到 false 才没有边界:这一支要回到「越界只标注、不拦」', () => {
    const dir = path.join(tmp, 'workspace')
    fs.mkdirSync(dir)
    expect(jailFor({ enabled: false }, dir)).toBeUndefined()
  })

  it('没选工作空间就无处可 jail:那支会话仍走「越界写入一律审批」的老路', () => {
    expect(jailFor(undefined, '')).toBeUndefined()
    expect(jailFor(undefined, '   ')).toBeUndefined()
  })
})

describe('根必须是真身', () => {
  it.skipIf(process.platform === 'win32')(
    '工作空间本身是软链时返回解出来的真身:判定层不再兜根那一侧,漏了这一步就会把根内判成越界',
    () => {
      const real = path.join(tmp, 'real')
      fs.mkdirSync(real)
      const link = path.join(tmp, 'link')
      fs.symlinkSync(real, link, 'dir')
      expect(jailFor(undefined, link)?.root).toBe(fs.realpathSync(real))
    }
  )

  it('工作空间还没被建出来时递归补上:用户选过一个已被删掉的目录不该让整轮没有边界', () => {
    const dir = path.join(tmp, 'nested', 'deeper')
    const jail = jailFor(undefined, dir)
    expect(jail?.root).toBe(fs.realpathSync(dir))
    expect(fs.existsSync(dir)).toBe(true)
  })
})

describe('fail-closed', () => {
  it('根建不出来时抛错而不是返回 undefined:静默退回无边界等于用户以为护栏还在', () => {
    writeFiles(tmp, { blocker: '这是个文件,不能当目录用' })
    const dir = path.join(tmp, 'blocker', 'workspace')
    expect(() => jailFor(undefined, dir)).toThrow(/已不可用/)
  })

  it('那句失败说明是陈述句、点明写入未执行,且不含「请改用 / 务必」这类祈使', () => {
    writeFiles(tmp, { blocker: '这是个文件,不能当目录用' })
    const dir = path.join(tmp, 'blocker', 'workspace')
    let message = ''
    try {
      jailFor(undefined, dir)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain(dir)
    expect(message).toContain('写入未执行')
    expect(message).not.toMatch(/请|务必|必须|应该|不要|换用|改用/)
  })
})
