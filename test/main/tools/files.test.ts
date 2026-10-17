import fs from 'node:fs'
import path from 'node:path'
import { readFileTool, writeFileTool } from '../../../src/main/tools/files'
import { createToolRunner } from '../../../src/main/tools/registry'
import { makeTempDir, removeTempDir } from '../../helpers/temp'
import type { ToolExecResult } from '../../../src/main/tools/types'

/**
 * 用真实 createToolRunner 组装:参数 JSON 解析、缺参校验、抛错转说明这几条链路一并被覆盖,
 * 而工具自己只负责抛错(见 AGENTS.md 的错误处理纪律)。
 */
const runner = createToolRunner([readFileTool, writeFileTool])
const ctx = { callId: 'call-1' }

let root = ''

beforeEach(() => {
  root = makeTempDir()
})

afterEach(() => {
  removeTempDir(root)
})

const file = (name: string): string => path.join(root, name)

function read(args: Record<string, unknown>): Promise<ToolExecResult> {
  return runner.execute('read_file', JSON.stringify(args), ctx)
}

function write(args: Record<string, unknown>): Promise<ToolExecResult> {
  return runner.execute('write_file', JSON.stringify(args), ctx)
}

/** 带工作空间的调用:临时目录每例都换,所以 ctx 必须现造 */
function inWorkspace(dir: string): { callId: string; workspace: string } {
  return { callId: 'call-ws', workspace: dir }
}

describe('read_file', () => {
  it('小文件给出原文与「路径:行数」的一行说明,正文不带行号', async () => {
    fs.writeFileSync(file('a.md'), '# 标题\n第二行\n', 'utf8')
    const res = await read({ path: file('a.md') })
    expect(res.ok).toBe(true)
    expect(res.result).toContain('# 标题\n第二行')
    expect(res.result).toMatch(/\[.+a\.md:3 行,\d+ B]$/)
    // 带行号会被模型连号一起抄进 write_file 的正文
    expect(res.result).not.toMatch(/^\s*1\s+# 标题/m)
  })

  it('路径不存在时给中文说明,而不是 ENOENT 原文', async () => {
    const res = await read({ path: file('nope.txt') })
    expect(res.ok).toBe(false)
    expect(res.result).toContain('路径不存在')
  })

  it('目标是目录时说明它是目录:模型会照提示改指向具体文件', async () => {
    const res = await read({ path: root })
    expect(res.ok).toBe(false)
    expect(res.result).toContain('是一个目录,不是文件')
  })

  it('开头含 NUL 就按二进制拒绝:乱码进上下文只会污染后面的回答', async () => {
    fs.writeFileSync(file('bin.dat'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]))
    const res = await read({ path: file('bin.dat') })
    expect(res.ok).toBe(false)
    expect(res.result).toContain('二进制文件')
  })

  it('空文件明确说空,而不是返回一段只有分隔符的正文', async () => {
    fs.writeFileSync(file('empty.txt'), '', 'utf8')
    const res = await read({ path: file('empty.txt') })
    expect(res.result).toContain('空文件')
  })

  it('超过单次上限就按行截断,并把下一段的 offset 写在说明里', async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `${i + 1}-${'x'.repeat(97)}`)
    fs.writeFileSync(file('big.txt'), lines.join('\n'), 'utf8')

    const first = await read({ path: file('big.txt') })
    const stop = Number(first.result.match(/本次返回第 1-(\d+) 行/)?.[1])
    expect(stop).toBeGreaterThan(1)
    expect(stop).toBeLessThan(lines.length)
    expect(first.result).toContain(`继续读把 offset 设为 ${stop + 1}`)

    const second = await read({ path: file('big.txt'), offset: stop + 1 })
    expect(second.result).toContain(lines[lines.length - 1])
    // 读到末尾就不该再给 offset,否则模型会以为还有后续内容而反复调
    expect(second.result).not.toContain('继续读把 offset 设为')
  })

  it('offset 超出行数时报错并给出真实行数', async () => {
    fs.writeFileSync(file('short.txt'), '一\n二\n', 'utf8')
    const res = await read({ path: file('short.txt'), offset: 9 })
    expect(res.ok).toBe(false)
    expect(res.result).toContain('只有 3 行')
  })

  it('offset 不是正整数就拒绝,不悄悄当成第 1 行重读整份', async () => {
    fs.writeFileSync(file('short.txt'), '一\n', 'utf8')
    for (const offset of [0, 1.5, 'abc']) {
      expect((await read({ path: file('short.txt'), offset })).result).toContain(
        'offset 要是从 1 开始的整数行号'
      )
    }
  })

  it('整份装得下时不加噪声:每次读小文件都多一段账目会挤掉正文', async () => {
    fs.writeFileSync(file('small.txt'), '只有两行\n第二行\n', 'utf8')
    const res = await read({ path: file('small.txt') })
    expect(res.result).toContain('只有两行\n第二行')
    expect(res.result).not.toContain('本次返回第')
  })
})

describe('write_file', () => {
  it('新建文件并自动补父目录:模型不会先去建目录', async () => {
    const target = path.join(root, 'deep/nested/out.md')
    const res = await write({ path: target, content: '# 结果\n' })
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(target, 'utf8')).toBe('# 结果\n')
    expect(res.result).toContain('已新建')
  })

  it('覆盖时说明盖掉了多大的旧内容:误覆盖至少留下了可追查的线索', async () => {
    const target = file('a.txt')
    const old = '旧的长内容长内容长内容'
    fs.writeFileSync(target, old, 'utf8')
    const res = await write({ path: target, content: '新' })
    expect(res.result).toContain(`已覆盖 ${target} 原有的 ${Buffer.byteLength(old)} B 内容`)
    expect(res.result).toContain(`本次写入 ${Buffer.byteLength('新')} B`)
    expect(fs.readFileSync(target, 'utf8')).toBe('新')
  })

  it('append=true 追加而不覆盖', async () => {
    const target = file('log.txt')
    fs.writeFileSync(target, '第一行\n', 'utf8')
    const res = await write({ path: target, content: '第二行\n', append: true })
    expect(res.result).toContain('已追加')
    expect(fs.readFileSync(target, 'utf8')).toBe('第一行\n第二行\n')
  })

  it('缺 content 时拒绝执行且不碰原文件:少一个参数就清空文件是最坏的失败', async () => {
    const target = file('keep.txt')
    fs.writeFileSync(target, '重要内容', 'utf8')
    const res = await write({ path: target })
    expect(res.ok).toBe(false)
    expect(res.result).toContain('缺少 content')
    expect(fs.readFileSync(target, 'utf8')).toBe('重要内容')
  })

  it('目标是目录时报错,不把它当文件写', async () => {
    const res = await write({ path: root, content: 'x' })
    expect(res.ok).toBe(false)
    expect(res.result).toContain('是一个目录')
  })

  it('写进去的字节数按 UTF-8 算:中文一个字三个字节,报字符数会让人误判', async () => {
    const content = '中文八字中文八字'
    const res = await write({ path: file('cn.txt'), content })
    expect(res.result).toContain(`${Buffer.byteLength(content)} B`)
    expect(Buffer.byteLength(content)).toBe(24)
  })
})

describe('工作空间', () => {
  it('给了工作空间后相对路径就在其中读写:模型不必知道应用的进程目录', async () => {
    fs.writeFileSync(file('notes.md'), '# 工作空间里的笔记\n', 'utf8')
    const res = await runner.execute(
      'read_file',
      JSON.stringify({ path: 'notes.md' }),
      inWorkspace(root)
    )
    expect(res.ok).toBe(true)
    expect(res.result).toContain('# 工作空间里的笔记')
    expect(res.result).toContain(file('notes.md'))
  })

  it('写也是同一个基准:相对路径写出的文件落在工作空间里', async () => {
    const res = await runner.execute(
      'write_file',
      JSON.stringify({ path: 'out/report.md', content: '# 结果\n' }),
      inWorkspace(root)
    )
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(path.join(root, 'out/report.md'), 'utf8')).toBe('# 结果\n')
  })

  it('绝对路径仍可读写,但结果里标注它在工作空间之外:放开作用域不等于悄悄越过', async () => {
    const outside = makeTempDir()
    try {
      fs.writeFileSync(path.join(outside, 'a.txt'), '在外面\n', 'utf8')
      const res = await runner.execute(
        'read_file',
        JSON.stringify({ path: path.join(outside, 'a.txt') }),
        inWorkspace(root)
      )
      expect(res.ok).toBe(true)
      expect(res.result).toContain('在外面')
      expect(res.result).toContain('在本次会话的工作空间')
      expect(res.result).toContain(root)
    } finally {
      removeTempDir(outside)
    }
  })

  it('工作空间内的绝对路径不加那句标注:每次都提示越界会变成噪声', async () => {
    fs.writeFileSync(file('b.txt'), '在里面\n', 'utf8')
    const res = await runner.execute(
      'read_file',
      JSON.stringify({ path: file('b.txt') }),
      inWorkspace(root)
    )
    expect(res.result).not.toContain('工作空间')
  })

  it('没选工作空间时退回应用当前目录,并且不提工作空间:那才是它真实落点', async () => {
    const ghost = 'cybertiger-no-such-file-under-cwd.md'
    const res = await runner.execute('read_file', JSON.stringify({ path: ghost }), ctx)
    expect(res.ok).toBe(false)
    expect(res.result).toContain(path.resolve(process.cwd(), ghost))
    expect(res.result).not.toContain('工作空间')
  })
})

describe('写入 jail（一期只约束 write_file）', () => {
  let ws = ''
  let outside = ''

  /**
   * 两边都取 realpath:mac 的临时目录本身在 `/private/var` 下,拿字形当根会把界内路径判成界外
   * —— 那正是 jail 里代价最高的一类错(判错方向是静默的)。
   * 生产里这一步由 `main/sandbox.ts` 的 `jailFor` 负责。
   */
  beforeEach(() => {
    ws = fs.realpathSync(makeTempDir())
    outside = fs.realpathSync(makeTempDir())
  })

  afterEach(() => {
    removeTempDir(ws)
    removeTempDir(outside)
  })

  /** jail 开着:根就是工作空间(与 `jailFor` 给的同一份) */
  function underJail(): { callId: string; workspace: string; jail: { root: string } } {
    return { callId: 'call-jail', workspace: ws, jail: { root: ws } }
  }

  function writeInJail(args: Record<string, unknown>): Promise<ToolExecResult> {
    return runner.execute('write_file', JSON.stringify(args), underJail())
  }

  it('根外的绝对路径被拒,且原文件的字节一个都没变', async () => {
    const target = path.join(outside, 'keep.txt')
    fs.writeFileSync(target, '原来的内容', 'utf8')

    const res = await writeInJail({ path: target, content: '改掉它' })
    expect(res.ok).toBe(false)
    expect(res.result).toContain('本次写入未执行')
    expect(res.result).toContain('之外')
    // 拒了却还是「成功写入」是最坏的形态:界面显示完成、机器上的文件已换
    expect(fs.readFileSync(target, 'utf8')).toBe('原来的内容')
  })

  it('根外的新文件也不会被建出来:拒绝发生在 mkdir 之前', async () => {
    const res = await writeInJail({ path: path.join(outside, 'nested/new.md'), content: 'x' })
    expect(res.ok).toBe(false)
    expect(fs.existsSync(path.join(outside, 'nested'))).toBe(false)
    expect(fs.existsSync(path.join(outside, 'nested/new.md'))).toBe(false)
  })

  it('../ 跳出根的相对路径同样被拒:模型更常写的是这种而不是绝对路径', async () => {
    const res = await writeInJail({ path: '../escape.txt', content: 'x' })
    expect(res.ok).toBe(false)
    expect(res.result).toContain('本次写入未执行')
    expect(fs.existsSync(path.join(ws, '..', 'escape.txt'))).toBe(false)
  })

  it('根内的深层新目录照旧能建:边界不能顺手把 mkdir 的递归能力废掉', async () => {
    const res = await writeInJail({ path: 'a/b/c/d.md', content: '# 结论\n' })
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(path.join(ws, 'a/b/c/d.md'), 'utf8')).toBe('# 结论\n')
    // 界内不该有那句越界标注
    expect(res.result).not.toContain('工作空间')
  })

  // win 上建软链要额外权限、libuv 也没有 O_NOFOLLOW,这两条只在 POSIX 侧跑
  it.skipIf(process.platform === 'win32')(
    '工作空间里一个指向外部目录的软链:写 link/id_rsa 被拒',
    async () => {
      fs.symlinkSync(outside, path.join(ws, 'link'))
      const res = await writeInJail({ path: path.join(ws, 'link', 'id_rsa'), content: '公钥\n' })
      expect(res.ok).toBe(false)
      expect(res.result).toContain('本次写入未执行')
      // 字形全程落在根内,只有解了真身才看得见它去了哪儿
      expect(fs.existsSync(path.join(outside, 'id_rsa'))).toBe(false)
    }
  )

  it.skipIf(process.platform === 'win32')(
    '最终组件是软链时不跟随:写入靠 O_NOFOLLOW 拒绝,而不是把内容送进链的另一头',
    async () => {
      const secret = path.join(outside, 'secret.txt')
      fs.writeFileSync(secret, '不该被动', 'utf8')
      fs.symlinkSync(secret, path.join(ws, 'link.txt'))

      // 没开 jail 也要挡住:这条与 jail 无关,是 open 那一层的纪律
      const res = await runner.execute(
        'write_file',
        JSON.stringify({ path: path.join(ws, 'link.txt'), content: '改掉' }),
        { callId: 'call-nolink', workspace: ws }
      )
      expect(res.ok).toBe(false)
      expect(res.result).toContain('软链')
      expect(fs.readFileSync(secret, 'utf8')).toBe('不该被动')
    }
  )

  it('追加不清空、覆盖不留旧尾巴:改成显式 flags 之后两种写法各钉一条', async () => {
    const target = path.join(ws, 'log.txt')
    fs.writeFileSync(target, '第一行\n', 'utf8')

    const appended = await writeInJail({ path: target, content: '第二行\n', append: true })
    expect(appended.ok).toBe(true)
    expect(appended.result).toContain('已追加')
    expect(fs.readFileSync(target, 'utf8')).toBe('第一行\n第二行\n')

    const overwritten = await writeInJail({ path: target, content: '只剩这行' })
    expect(overwritten.result).toContain('原有的')
    expect(fs.readFileSync(target, 'utf8')).toBe('只剩这行')
  })

  it('没开 jail 时越界写仍然成功并带那句标注:默认行为一字不变', async () => {
    const target = path.join(outside, 'a.txt')
    const res = await runner.execute(
      'write_file',
      JSON.stringify({ path: target, content: '在外面\n' }),
      { callId: 'call-plain', workspace: ws }
    )
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(target, 'utf8')).toBe('在外面\n')
    expect(res.result).toContain('在本次会话的工作空间')
    expect(res.result).toContain(ws)
  })

  it('jail 开着时根外的读仍然成功:一期只约束写,别悄悄把读也挡了', async () => {
    fs.writeFileSync(path.join(outside, 'secret.txt'), '根外可读\n', 'utf8')
    const res = await runner.execute(
      'read_file',
      JSON.stringify({ path: path.join(outside, 'secret.txt') }),
      underJail()
    )
    expect(res.ok).toBe(true)
    expect(res.result).toContain('根外可读')
    expect(res.result).toContain('在本次会话的工作空间')
  })
})

describe('大文件', () => {
  it('超过整体读取上限时拒绝,并提示改用 run_command 按行取片段', async () => {
    const target = file('huge.txt')
    fs.writeFileSync(target, Buffer.alloc(2 * 1024 * 1024 + 10, 0x61))
    const res = await read({ path: target })
    expect(res.ok).toBe(false)
    expect(res.result).toContain('超过单次读取上限')
    expect(res.result).toContain('run_command')
  })
})
