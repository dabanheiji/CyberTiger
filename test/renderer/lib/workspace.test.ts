import {
  NO_WORKSPACE_GROUP,
  pushRecent,
  workspaceGroupDir,
  workspaceGroupKey,
  workspaceLabel
} from '../../../src/renderer/src/lib/workspace'

describe('workspaceLabel', () => {
  it('取末段目录名:底栏那一行放得下,和 IDE 标题栏一个读法', () => {
    expect(workspaceLabel('/Users/dev/code/shop')).toBe('shop')
    expect(workspaceLabel('C:\\Users\\dev\\code\\shop')).toBe('shop')
  })

  it('根目录保留整串:去掉尾部分隔符后是空串,标签空白等于看不出选了哪儿', () => {
    expect(workspaceLabel('/')).toBe('/')
  })

  it('尾部的分隔符不算名字:选目录对话框返回的路径有时带斜杠', () => {
    expect(workspaceLabel('/Users/dev/code/')).toBe('code')
  })

  it('空与纯空白都说「未选择」,而不是留一个空白按钮', () => {
    expect(workspaceLabel('')).toBe('未选择工作空间')
    expect(workspaceLabel('   ')).toBe('未选择工作空间')
  })
})

describe('pushRecent', () => {
  it('新的挪到最前:最近列表按「刚用过」排,选下一个时不用翻', () => {
    expect(pushRecent(['/b'], '/a')).toEqual(['/a', '/b'])
  })

  it('同一路径只占一格:来回切两次不该把列表挤满重复项', () => {
    expect(pushRecent(['/a', '/b'], '/b')).toEqual(['/b', '/a'])
  })

  it('超出上限时丢尾部那些:清单本来就是新在前,尾巴就是最旧的', () => {
    const list = ['/4', '/3', '/2', '/1']
    expect(pushRecent(list, '/5', 3)).toEqual(['/5', '/4', '/3'])
  })

  it('空路径不入列:清除工作空间不该往最近里塞一条空白记录', () => {
    expect(pushRecent(['/a'], '  ')).toEqual(['/a'])
  })

  it('把清单里已有的空项顺手清掉', () => {
    expect(pushRecent(['', '/a'], '/b')).toEqual(['/b', '/a'])
  })
})

describe('会话列表的工作空间分组键', () => {
  it('同一个目录的会话得到同一个键:侧栏按字符串相等分组,键不同就散成两组', () => {
    expect(workspaceGroupKey('/a/b')).toBe('/a/b')
  })

  it('首尾空白不算差别:库里存的路径带个空格就裂成两个分组', () => {
    expect(workspaceGroupKey(' /a/b ')).toBe(workspaceGroupKey('/a/b'))
  })

  it('未选工作空间用一个非空哨兵:组件把空 group 当作「这条不分组」,那些会话会夹在各组之间、连组标题都没有', () => {
    expect(workspaceGroupKey('')).toBe(NO_WORKSPACE_GROUP)
    expect(workspaceGroupKey('  ')).toBe(NO_WORKSPACE_GROUP)
  })

  it('哨兵折回空串:组标题那颗「+」据此开一个不带工作空间的草稿', () => {
    expect(workspaceGroupDir(NO_WORKSPACE_GROUP)).toBe('')
    expect(workspaceGroupDir('/a/b')).toBe('/a/b')
  })

  it('组标签取末段名,和底栏选择器同一个读法;哨兵那组明说没选', () => {
    expect(workspaceLabel(workspaceGroupDir(workspaceGroupKey('/a/b/c')))).toBe('c')
    expect(workspaceLabel(workspaceGroupDir(NO_WORKSPACE_GROUP))).toBe('未选择工作空间')
  })
})
