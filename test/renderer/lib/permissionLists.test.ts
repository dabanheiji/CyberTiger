import { LIST_ENTRY_SHAPES as JUDGED } from '../../../src/main/tools/permission'
import {
  LIST_ENTRY_SHAPES,
  MAX_LIST_ENTRIES,
  parsePermissionList
} from '../../../src/renderer/src/lib/permissionLists'

describe('parsePermissionList', () => {
  it('按行切并去掉首尾空白:名单就是一行一条的纯文本,粘贴带来的空格不该进条目', () => {
    expect(parsePermissionList('  git status  \nrm\n')).toEqual(['git status', 'rm'])
  })

  it('空行不算条目:用户为了排版空一行,不等于配了一条空名单', () => {
    expect(parsePermissionList('\n\na\n   \nb\n')).toEqual(['a', 'b'])
  })

  it('重复的只留第一次出现的那条,顺序照用户写的走', () => {
    expect(parsePermissionList('b\na\nb')).toEqual(['b', 'a'])
  })

  it('超出上限就截住:再多过这条线用户已经不会回头读自己配了什么', () => {
    const text = Array.from({ length: MAX_LIST_ENTRIES + 20 }, (_, i) => `cmd${String(i)}`).join(
      '\n'
    )
    expect(parsePermissionList(text)).toHaveLength(MAX_LIST_ENTRIES)
  })

  it('全空白文本切成空数组,而不是留下一条空条目', () => {
    expect(parsePermissionList('  \n \n')).toEqual([])
  })
})

describe('LIST_ENTRY_SHAPES', () => {
  it('界面那份与主进程判定用的是同一串:抄错了不会报错,只会让用户配出一个不生效的条目', () => {
    expect(LIST_ENTRY_SHAPES).toEqual(JUDGED)
  })

  it('三种形状各说一句,且都点名了自己的匹配范围', () => {
    expect(LIST_ENTRY_SHAPES).toHaveLength(3)
    expect(LIST_ENTRY_SHAPES[0]).toContain('run_command')
    expect(LIST_ENTRY_SHAPES[1]).toContain('工具名')
    expect(LIST_ENTRY_SHAPES[2]).toContain('__')
  })
})
