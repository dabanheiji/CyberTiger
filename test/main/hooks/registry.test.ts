import fs from 'node:fs'
import path from 'node:path'
import { HOOK_FILE, hookRegistry, hooksDir, runsAsLabel } from '../../../src/main/hooks/registry'
import { store } from '../../../src/main/store'
import type { SandboxExecStatus } from '../../../src/main/store/types'
import type { HookDraft } from '../../../src/main/hooks/types'
import {
  hookDoc,
  makeTempDir,
  releaseHooksDir,
  removeTempDir,
  useHooksDir,
  writeFiles
} from '../../helpers/temp'
import { resetSettings } from '../../helpers/settings'

/**
 * 注册表看的是「磁盘上那一批声明」,不起进程,所以这一份不需要 sandbox-exec。
 *
 * 三组断言各自钉住一种坏法:
 * - 顺序不确定 → 多个钩子的说明拼接、否决优先级与改写级联会按平台/文件系统变;
 * - 解析失败的目录被吞掉 → 用户装的那条悄悄失灵,而界面上什么都没有;
 * - 软链没做第二次判定 → 列表说「这条钩子在 hooks/x」,实际跑的是另一个目录里的文件。
 */

const disabledNames = (): string[] => store.get('disabledHooks') ?? []

let root = ''

function draft(name: string, overrides: Partial<HookDraft> = {}): HookDraft {
  return {
    name,
    description: `${name} 的说明`,
    event: 'beforeAgent',
    command: '/usr/bin/true',
    ...overrides
  }
}

/** 装一条钩子:目录名与声明里的 name 必须一致,这本来就是注册表的判定 */
function install(dirName: string, content = hookDoc(dirName)): void {
  writeFiles(root, { [`${dirName}/${HOOK_FILE}`]: content })
}

beforeEach(() => {
  root = makeTempDir()
  useHooksDir(root)
  resetSettings()
  hookRegistry.scan()
})

afterEach(() => {
  releaseHooksDir()
  removeTempDir(root)
  resetSettings()
})

describe('目录扫描', () => {
  it('按名字排序,点开头的目录与文件都不算一条钩子', () => {
    writeFiles(root, {
      [`zeta/${HOOK_FILE}`]: hookDoc('zeta', { description: 'Z' }),
      [`alpha/${HOOK_FILE}`]: hookDoc('alpha', { description: 'A' }),
      ['.hidden/x']: '不计',
      'loose.txt': '不计'
    })
    hookRegistry.scan()
    expect(hookRegistry.list().map((h) => h.name)).toEqual(['alpha', 'zeta'])
  })

  it('目录不存在等于一条都没装,不是失败', () => {
    releaseHooksDir()
    useHooksDir(path.join(root, '还没有人建过这个目录'))
    expect(() => hookRegistry.scan()).not.toThrow()
    expect(hookRegistry.list()).toEqual([])
    useHooksDir(root)
  })

  it('解析失败的目录带 error 且固定禁用,别的那条照装', () => {
    install('broken', '没有 frontmatter')
    install('ok')
    hookRegistry.scan()
    expect(hookRegistry.get('broken')).toMatchObject({
      description: '',
      event: 'beforeAgent',
      command: '',
      enabled: false,
      error: '必须以 YAML frontmatter(---)开头'
    })
    expect(hookRegistry.getEnabled()).toEqual([expect.objectContaining({ name: 'ok' })])
  })

  it('声明里的 name 与目录名不一致时按解析失败处理', () => {
    install('alpha', hookDoc('beta'))
    hookRegistry.scan()
    expect(hookRegistry.get('alpha')?.error).toContain('必须与目录名 "alpha" 一致')
    expect(hookRegistry.getEnabled()).toEqual([])
  })

  it('hooksDir 优先取环境变量', () => {
    expect(hooksDir()).toBe(root)
    releaseHooksDir()
    expect(hooksDir().endsWith('hooks')).toBe(true)
    useHooksDir(root)
  })

  it.skipIf(process.platform === 'win32')(
    '软链目录不当作一条钩子:目录名就是身份,链过来的那份声明认不出自己属于哪儿',
    () => {
      const outside = makeTempDir()
      try {
        writeFiles(outside, { [`linked/${HOOK_FILE}`]: hookDoc('linked') })
        fs.symlinkSync(path.join(outside, 'linked'), path.join(root, 'linked'), 'dir')
        hookRegistry.scan()
        expect(hookRegistry.list()).toEqual([])
      } finally {
        removeTempDir(outside)
      }
    }
  )
})

describe('HOOK.md 是软链时的两次判定', () => {
  it.skipIf(process.platform === 'win32')(
    '指向 hooks 目录之外即解析失败,报的是解出来的真身',
    () => {
      const outside = makeTempDir()
      try {
        const target = path.join(outside, 'elsewhere.md')
        fs.writeFileSync(target, hookDoc('escaped'), 'utf8')
        fs.mkdirSync(path.join(root, 'escaped'), { recursive: true })
        fs.symlinkSync(target, path.join(root, 'escaped', HOOK_FILE), 'file')
        hookRegistry.scan()
        expect(hookRegistry.get('escaped')?.error).toContain('指向了 hooks 目录之外')
        expect(hookRegistry.get('escaped')?.enabled).toBe(false)
        expect(hookRegistry.getEnabled()).toEqual([])
      } finally {
        removeTempDir(outside)
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    '指向 hooks 目录内另一个文件照样读得到:判定看的是边界,不是「必须是真身文件」',
    () => {
      writeFiles(root, { 'shared.md': hookDoc('inner') })
      fs.mkdirSync(path.join(root, 'inner'), { recursive: true })
      fs.symlinkSync(path.join(root, 'shared.md'), path.join(root, 'inner', HOOK_FILE), 'file')
      hookRegistry.scan()
      // 内容里的 name 是 inner,与目录名一致,所以这一条成立
      expect(hookRegistry.get('inner')?.error).toBeUndefined()
      expect(hookRegistry.get('inner')?.enabled).toBe(true)
    }
  )
})

describe('启停', () => {
  it('disabledHooks 里的名字不进 getEnabled,但仍能被 get 到', () => {
    install('notify')
    store.set('disabledHooks', ['notify'])
    hookRegistry.scan()
    expect(hookRegistry.get('notify')?.enabled).toBe(false)
    expect(hookRegistry.getEnabled()).toEqual([])
  })

  it('setEnabled 写 store、重扫并广播', () => {
    install('notify')
    hookRegistry.refresh()
    const seen: boolean[] = []
    hookRegistry.onChange((list) =>
      seen.push(list.find((h) => h.name === 'notify')?.enabled ?? false)
    )

    hookRegistry.setEnabled('notify', false)
    expect(disabledNames()).toEqual(['notify'])
    expect(seen).toEqual([false])

    hookRegistry.setEnabled('notify', true)
    expect(disabledNames()).toEqual([])
    expect(hookRegistry.get('notify')?.enabled).toBe(true)
    expect(seen).toEqual([false, true])
  })

  it('不存在的钩子启停被拒', () => {
    expect(() => hookRegistry.setEnabled('nope', true)).toThrow('钩子 "nope" 不存在')
  })

  it('getEnabled 按事件筛,其余事件的钩子不进来', () => {
    install('a', hookDoc('a', { event: 'beforeToolCall' }))
    install('b', hookDoc('b', { event: 'afterAgent' }))
    hookRegistry.scan()
    expect(hookRegistry.getEnabled('beforeToolCall').map((h) => h.name)).toEqual(['a'])
    expect(hookRegistry.getEnabled('afterAgent').map((h) => h.name)).toEqual(['b'])
    expect(hookRegistry.getEnabled('beforeAgent')).toEqual([])
  })
})

describe('界面上每一行', () => {
  const SEATBELT: SandboxExecStatus = {
    platform: 'darwin',
    engine: 'seatbelt',
    available: true
  }
  const NOWHERE: SandboxExecStatus = { platform: 'win32', engine: 'none', available: true }
  const BROKEN: SandboxExecStatus = {
    platform: 'linux',
    engine: 'bwrap',
    available: false,
    reason: '这台机器上没有 bwrap'
  }

  it('相对钩子目录的 command 给出真身,裸命令名给空串', () => {
    install('notify', hookDoc('notify', { command: './hook.mjs' }))
    install('beep', hookDoc('beep', { command: 'say' }))
    hookRegistry.scan()
    const rows = hookRegistry.rows(SEATBELT)
    expect(rows.find((r) => r.meta.name === 'notify')?.resolvedPath).toBe(
      path.join(root, 'notify', 'hook.mjs')
    )
    expect(rows.find((r) => r.meta.name === 'beep')?.resolvedPath).toBe('')
  })

  it('解析失败的行不带 resolvedPath:空 command 会解出 hooks 目录本身,界面上看着像路径对上了', () => {
    install('broken', '没有 frontmatter')
    hookRegistry.scan()
    const [row] = hookRegistry.rows(SEATBELT)
    expect(row.error).toBeDefined()
    expect(row.resolvedPath).toBe('')
  })

  it('sandboxed 为假时一律写「未受限(默认)」,与这台机器有没有机制无关', () => {
    expect(runsAsLabel(false, undefined, undefined)).toBe('未受限(默认)')
    expect(runsAsLabel(false, { enabled: true, exec: true }, BROKEN)).toBe('未受限(默认)')
  })

  it('三颗开关各自关掉时说的是不同的那句话,不能都印成「未受限」', () => {
    expect(runsAsLabel(true, { enabled: false }, SEATBELT)).toBe('未受限(沙箱已被你关掉)')
    expect(runsAsLabel(true, { enabled: true, exec: false }, SEATBELT)).toBe(
      '未受限(「把命令关进受限执行环境」那一颗关着)'
    )
  })

  it('这台机器没有对应机制与装不上是分开的两件事', () => {
    expect(runsAsLabel(true, { enabled: true, exec: true }, NOWHERE)).toBe(
      '未受限(这台机器没有对应的机制)'
    )
    expect(runsAsLabel(true, { enabled: true, exec: true }, BROKEN)).toBe(
      '不会运行(受限执行在这台机器上不可用)'
    )
  })

  it('沙箱开着、机制也在,但这一条能不能受限还取决于会话有没有选工作空间', () => {
    // status 为 undefined 就是「这次快照没有边界可依据」;界面不能把它印成「受限」
    expect(runsAsLabel(true, { enabled: true, exec: true }, undefined)).toBe(
      '受限(需要本次会话选了工作空间)'
    )
    expect(runsAsLabel(true, undefined, SEATBELT)).toBe('受限(需要本次会话选了工作空间)')
  })
})

describe('新建与编辑', () => {
  it('create 落盘 HOOK.md 并立刻可见', async () => {
    await hookRegistry.create(draft('notify', { command: './hook.mjs', timeout: 5000 }))
    const dir = path.join(root, 'notify')
    expect(fs.existsSync(path.join(dir, HOOK_FILE))).toBe(true)
    expect(hookRegistry.get('notify')).toMatchObject({
      description: 'notify 的说明',
      event: 'beforeAgent',
      command: './hook.mjs',
      timeoutMs: 5000,
      dir,
      enabled: true
    })
  })

  it('重名时拒绝,不覆盖已有的那条', async () => {
    await hookRegistry.create(draft('notify'))
    await expect(hookRegistry.create(draft('notify'))).rejects.toThrow('钩子 "notify" 已存在')
    expect(fs.readFileSync(path.join(root, 'notify', HOOK_FILE), 'utf8')).toContain(
      'command: /usr/bin/true'
    )
  })

  it('非法名字在建目录前就被拦下', async () => {
    await expect(hookRegistry.create(draft('Bad Name'))).rejects.toThrow(/只能包含小写字母/)
    expect(fs.existsSync(path.join(root, 'Bad Name'))).toBe(false)
  })

  it('同名编辑只改写文件,目录不动', async () => {
    await hookRegistry.create(draft('notify'))
    await hookRegistry.update('notify', draft('notify', { description: '改过的说明' }))
    expect(fs.existsSync(path.join(root, 'notify'))).toBe(true)
    expect(hookRegistry.get('notify')?.description).toBe('改过的说明')
  })

  it('改名时先写新目录再删旧目录,禁用状态跟过去', async () => {
    await hookRegistry.create(draft('notify'))
    hookRegistry.setEnabled('notify', false)
    await hookRegistry.update('notify', draft('announce'))
    expect(fs.existsSync(path.join(root, 'notify'))).toBe(false)
    expect(disabledNames()).toEqual(['announce'])
    expect(hookRegistry.get('announce')?.enabled).toBe(false)
  })

  it('改名撞上已有钩子时拒绝,原来那条保持可用', async () => {
    await hookRegistry.create(draft('notify'))
    await hookRegistry.create(draft('announce'))
    await expect(hookRegistry.update('notify', draft('announce'))).rejects.toThrow(
      '钩子 "announce" 已存在'
    )
    expect(hookRegistry.get('notify')?.enabled).toBe(true)
    expect(fs.existsSync(path.join(root, 'notify'))).toBe(true)
  })

  it('编辑不存在的钩子被拒', async () => {
    await expect(hookRegistry.update('nope', draft('nope'))).rejects.toThrow('钩子 "nope" 不存在')
  })

  it('并发新建按顺序执行,不会互相踩踏', async () => {
    await Promise.all([
      hookRegistry.create(draft('alpha')),
      hookRegistry.create(draft('beta')),
      hookRegistry.create(draft('gamma'))
    ])
    expect(hookRegistry.list().map((h) => h.name)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('新建时校验不过的草稿不落盘:界面上的错误与文件里的错误是同一套', async () => {
    await expect(hookRegistry.create(draft('x', { event: 'nope' as never }))).rejects.toThrow(
      'event "nope" 认不出来'
    )
    expect(fs.existsSync(path.join(root, 'x'))).toBe(false)
  })
})

describe('删除', () => {
  it('remove 清掉目录与禁用记录', async () => {
    await hookRegistry.create(draft('notify'))
    hookRegistry.setEnabled('notify', false)
    await hookRegistry.remove('notify')
    expect(fs.existsSync(path.join(root, 'notify'))).toBe(false)
    expect(hookRegistry.get('notify')).toBeUndefined()
    expect(disabledNames()).toEqual([])
  })

  it('删除不存在的钩子被拒,且不影响后续操作', async () => {
    await hookRegistry.create(draft('alpha'))
    await expect(hookRegistry.remove('nope')).rejects.toThrow('钩子 "nope" 不存在')
    await hookRegistry.remove('alpha')
    expect(hookRegistry.list()).toEqual([])
  })
})
