import path from 'node:path'
import { resolveTerminalCwd } from '../../../src/main/terminal/cwd'

const HOME = '/Users/tester'

function dirs(...values: string[]): (dir: string) => boolean {
  const set = new Set(values)
  return (dir) => set.has(dir)
}

describe('resolveTerminalCwd', () => {
  it('工作空间存在就用它:这是「终端默认在工作空间」那条要求的第一优先项', () => {
    const result = resolveTerminalCwd(
      [{ dir: '/ws/project', source: 'workspace' }],
      dirs('/ws/project', '/ws/default'),
      HOME
    )
    expect(result).toEqual({ cwd: '/ws/project', source: 'workspace' })
  })

  it('工作空间为空时退到默认工作空间:草稿态还没有会话行,只有这个待用值', () => {
    const result = resolveTerminalCwd(
      [
        { dir: '', source: 'workspace' },
        { dir: '/ws/default', source: 'default-workspace' }
      ],
      dirs('/ws/default'),
      HOME
    )
    expect(result).toEqual({ cwd: '/ws/default', source: 'default-workspace' })
  })

  it('工作空间路径已不存在(被删 / 改名为文件)时继续往后退,不把终端起在一个坏目录上', () => {
    const result = resolveTerminalCwd(
      [
        { dir: '/ws/gone', source: 'workspace' },
        { dir: '/ws/default', source: 'default-workspace' }
      ],
      dirs('/ws/default'),
      HOME
    )
    expect(result.source).toBe('default-workspace')
    expect(result.cwd).toBe('/ws/default')
  })

  it('两个候选都不成立时退到主目录,并明确标注 home:界面据此给一条提示', () => {
    const result = resolveTerminalCwd(
      [
        { dir: '/ws/gone', source: 'workspace' },
        { dir: '   ', source: 'default-workspace' }
      ],
      dirs(),
      HOME
    )
    expect(result).toEqual({ cwd: HOME, source: 'home' })
  })

  it('纯空白的候选等于没有选:不拿空白去拼一个相对路径', () => {
    const result = resolveTerminalCwd(
      [
        { dir: '   ', source: 'workspace' },
        { dir: '/ws/default', source: 'default-workspace' }
      ],
      dirs('/ws/default'),
      HOME
    )
    expect(result.source).toBe('default-workspace')
  })

  it('候选先归一成绝对路径再判断:带 .. 的写法与它的真身是同一个目录', () => {
    const normalized = path.resolve('/ws/project/sub/..')
    const result = resolveTerminalCwd(
      [{ dir: '/ws/project/sub/..', source: 'workspace' }],
      dirs(normalized),
      HOME
    )
    expect(result.cwd).toBe(normalized)
  })
})
