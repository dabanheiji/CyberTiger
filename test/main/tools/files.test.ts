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
