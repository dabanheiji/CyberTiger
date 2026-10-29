import { HOOK_MATCHER_SHAPES as JUDGED } from '../../../src/main/hooks/matcher'
import {
  HOOK_MATCHER_SHAPES,
  joinHookEntries,
  parseHookEntries
} from '../../../src/renderer/src/lib/hookMatchers'

describe('parseHookEntries', () => {
  it('按行切并去掉首尾空白:一行一条是这里唯一的排版方式', () => {
    expect(parseHookEntries('  run_command:git push \nwrite_file\n')).toEqual([
      'run_command:git push',
      'write_file'
    ])
  })

  it('空行不算条目:为了排版空一行不等于配了一条空 matcher', () => {
    expect(parseHookEntries('\n\na\n   \nb\n')).toEqual(['a', 'b'])
  })

  it('与审批名单的编辑器相反,这里不去重也不剪上限:静默丢掉一条 matcher 会让拦截范围比用户配的更松,超限该由主进程报错而不是界面替他改', () => {
    expect(parseHookEntries('b\na\nb')).toEqual(['b', 'a', 'b'])
    const many = Array.from({ length: 200 }, (_, i) => `tool_${String(i)}`).join('\n')
    expect(parseHookEntries(many)).toHaveLength(200)
  })

  it('全空白文本切成空数组,而空数组就是「这个时机下的每一次调用都触发」', () => {
    expect(parseHookEntries('  \n \n')).toEqual([])
  })

  it('数组回到文本再切出去,逐条一字不变:界面靠这一步判断有没有改动', () => {
    const entries = ['github__', 'run_command:git push']
    expect(parseHookEntries(joinHookEntries(entries))).toEqual(entries)
  })
})

describe('HOOK_MATCHER_SHAPES', () => {
  it('界面那份与主进程命中判定用的是同一串:抄错了不会报错,只会让用户配出一条永远不生效的条目', () => {
    expect(HOOK_MATCHER_SHAPES).toEqual(JUDGED)
  })

  it('五种形状各说一句,且都点名了自己的匹配范围', () => {
    expect(HOOK_MATCHER_SHAPES).toHaveLength(5)
    expect(HOOK_MATCHER_SHAPES[1]).toContain('工具名')
    expect(HOOK_MATCHER_SHAPES[2]).toContain('__')
    expect(HOOK_MATCHER_SHAPES[3]).toContain('run_command')
  })

  it('把「任一分段命中就触发」写进说明:这条与审批名单相反,不写明就会被当成写错了', () => {
    expect(HOOK_MATCHER_SHAPES.join('\n')).toContain('任一分段命中')
  })
})
