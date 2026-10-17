import path from 'node:path'
import { LIST_ENTRY_SHAPES, needsApproval, stricterMode } from '../../../src/main/tools/permission'
import type { ApprovalQuery, PermissionLists } from '../../../src/main/tools/permission'
import type { PermissionMode } from '../../../src/main/store/types'

// 判定与 anchor 都只做纯文本的路径比较,不必真有一个目录
const WS = path.join(path.sep, 'ws')
const EMPTY: PermissionLists = { allow: [], deny: [] }

function query(overrides: Partial<ApprovalQuery> = {}): ApprovalQuery {
  return {
    mode: 'ask',
    toolName: 'run_command',
    args: { command: 'ls' },
    workspace: WS,
    isMcpTool: false,
    lists: EMPTY,
    agent: '',
    ...overrides
  }
}

/** 要审批时返回载荷,免审批时为 null —— 用例都按「问不问」断言 */
function asks(input: Partial<ApprovalQuery>): boolean {
  return needsApproval(query(input)) !== null
}

describe('档位表:文件读写', () => {
  it.each(['ask', 'auto', 'full'] as PermissionMode[])(
    '工作空间内的 %s 档都不问:选了那个目录就是「这里随你读写」',
    (mode) => {
      expect(asks({ mode, toolName: 'read_file', args: { path: 'a.ts' } })).toBe(false)
      expect(asks({ mode, toolName: 'write_file', args: { path: 'a.ts', content: 'x' } })).toBe(
        false
      )
    }
  )

  it('读工作空间外的文件:询问审批与自动审批都要问', () => {
    expect(asks({ mode: 'ask', toolName: 'read_file', args: { path: '/etc/hosts' } })).toBe(true)
    expect(asks({ mode: 'auto', toolName: 'read_file', args: { path: '~/notes.md' } })).toBe(true)
  })

  it('读工作空间外的文件:完全访问免审 —— 那一档的意思就是「整台机器随你读」', () => {
    expect(asks({ mode: 'full', toolName: 'read_file', args: { path: '/etc/hosts' } })).toBe(false)
  })

  it('写工作空间外:两档要问、full 免,载荷里写明越界与覆盖方式', () => {
    const requirement = needsApproval(
      query({
        mode: 'ask',
        toolName: 'write_file',
        args: { path: path.join(path.sep, 'tmp', 'out.txt'), content: 'hi' }
      })
    )
    expect(requirement).not.toBeNull()
    expect(requirement?.summary).toContain('写入工作空间之外的文件')
    expect(requirement?.detail.join('\n')).toContain('本次会话的工作空间之外')
    expect(requirement?.detail.join('\n')).toContain('将整文件覆盖')
  })

  it('未选工作空间时写文件一律要问:没有授权范围就等于没有授权', () => {
    for (const mode of ['ask', 'auto'] as PermissionMode[]) {
      expect(asks({ mode, workspace: '', toolName: 'write_file', args: { path: 'a.md' } })).toBe(
        true
      )
    }
    // full 档不受这条影响:它免的是「越界」本身,而这里连越界都判不出来
    expect(
      asks({ mode: 'full', workspace: '', toolName: 'write_file', args: { path: 'a.md' } })
    ).toBe(false)
  })

  it('未选工作空间时读文件免审(已知留白):anchor 判不出越界,而这一期的写入边界只管写', () => {
    expect(asks({ workspace: '', toolName: 'read_file', args: { path: '/etc/passwd' } })).toBe(
      false
    )
  })
})

describe('jail 开着时,审批为写入边界让位', () => {
  const JAIL = { root: WS }

  it('根外的 write_file 不再要审批:卡片不该承诺一件注定失败的事', () => {
    for (const mode of ['ask', 'auto'] as PermissionMode[]) {
      expect(
        asks({
          mode,
          jail: JAIL,
          toolName: 'write_file',
          args: { path: path.join(path.sep, 'tmp', 'out.txt'), content: 'x' }
        })
      ).toBe(false)
    }
  })

  it('让位只发生在越界那一边:根内的写入结论与 jail 无关', () => {
    expect(asks({ jail: JAIL, toolName: 'write_file', args: { path: 'a.ts', content: 'x' } })).toBe(
      false
    )
  })

  it('读侧一条都不改:这一期 jail 只收写,根外的 read_file 照旧弹卡片', () => {
    for (const mode of ['ask', 'auto'] as PermissionMode[]) {
      expect(asks({ mode, jail: JAIL, toolName: 'read_file', args: { path: '/etc/hosts' } })).toBe(
        true
      )
    }
    expect(
      asks({ mode: 'full', jail: JAIL, toolName: 'read_file', args: { path: '/etc/hosts' } })
    ).toBe(false)
  })

  it('run_command 也不改:受限执行还在下一期,工作目录越界照样要问', () => {
    expect(asks({ mode: 'ask', jail: JAIL, args: { command: 'ls', cwd: '/tmp' } })).toBe(true)
    expect(asks({ mode: 'auto', jail: JAIL, args: { command: 'ls', cwd: '/tmp' } })).toBe(true)
  })

  it('没给根时判定与今天完全一致,连载荷都不变:关掉开关要回到逐条问,而不是两边都不管', () => {
    const without = needsApproval(
      query({ toolName: 'write_file', args: { path: '/tmp/out.txt', content: 'x' } })
    )
    expect(without).not.toBeNull()
    expect(without?.summary).toContain('写入工作空间之外的文件')
    expect(without?.detail.join('\n')).toContain('该路径在本次会话的工作空间之外')
  })

  it('黑名单仍然先问:它是唯一在任何档位都拦得住的闸门,不因 jail 而退场', () => {
    const requirement = needsApproval(
      query({
        lists: { allow: [], deny: ['write_file'] },
        jail: JAIL,
        toolName: 'write_file',
        args: { path: '/tmp/out.txt', content: 'x' }
      })
    )
    expect(requirement?.risk).toBe('listed')
  })
})

describe('档位表:shell 命令', () => {
  it('低风险命令在自动审批档免审,在询问审批档照问', () => {
    expect(asks({ mode: 'auto', args: { command: 'ls -la' } })).toBe(false)
    expect(asks({ mode: 'ask', args: { command: 'ls -la' } })).toBe(true)
  })

  it('询问审批档下低风险载荷会标出 risk=low:否则用户看不出这一档为什么连 ls 都问', () => {
    const requirement = needsApproval(query({ mode: 'ask', args: { command: 'ls' } }))
    expect(requirement?.risk).toBe('low')
  })

  it('证明不了安全的命令在自动审批档也要问,并把理由逐条带给界面', () => {
    const requirement = needsApproval(
      query({ mode: 'auto', args: { command: 'npm install left-pad' } })
    )
    expect(requirement?.risk).toBe('elevated')
    expect(requirement?.detail.join('\n')).toContain('风险:')
  })

  it('完全访问档下命令一律免审', () => {
    expect(asks({ mode: 'full', args: { command: 'rm -rf build' } })).toBe(false)
  })

  it('cwd 落在工作空间外时,即使命令本身只读也算要问:出了授权范围', () => {
    expect(asks({ mode: 'auto', args: { command: 'ls', cwd: '/tmp' } })).toBe(true)
    expect(asks({ mode: 'auto', args: { command: 'ls', cwd: 'src' } })).toBe(false)
  })

  it('风险键带上实际 cwd:放行了 /tmp 的 ls 不等于放行所有目录的 ls', () => {
    const requirement = needsApproval(query({ args: { command: 'ls', cwd: '/tmp' } }))
    expect(requirement?.runAllowKey).toBe(`ls [cwd=${path.join(path.sep, 'tmp')}]`)
  })
})

describe('档位表:MCP 与不在审批面内的工具', () => {
  it('MCP 工具在询问审批与自动审批都要问,在完全访问免审', () => {
    for (const mode of ['ask', 'auto'] as PermissionMode[]) {
      expect(asks({ mode, toolName: 'github__create_issue', isMcpTool: true, args: {} })).toBe(true)
    }
    expect(
      asks({ mode: 'full', toolName: 'github__create_issue', isMcpTool: true, args: {} })
    ).toBe(false)
  })

  it('ask_user 与 task 不在审批面内:前者本来就停在用户身上,后者各自过闸门', () => {
    for (const mode of ['ask', 'auto'] as PermissionMode[]) {
      expect(asks({ mode, toolName: 'ask_user', args: { question: 'x' } })).toBe(false)
      expect(asks({ mode, toolName: 'task', args: { prompt: 'x' } })).toBe(false)
      expect(asks({ mode, toolName: 'get_current_time', args: {} })).toBe(false)
    }
  })

  it('子 Agent 发起时载荷会写明是谁在动手', () => {
    const requirement = needsApproval(query({ agent: 'code-reviewer' }))
    expect(requirement?.detail.join('\n')).toContain('由子 Agent「code-reviewer」发起')
  })
})

describe('名单:三种条目形状', () => {
  it('命令前缀按 token 边界匹配:后缀更长的名字不算命中', () => {
    const lists: PermissionLists = { allow: ['git status'], deny: [] }
    expect(asks({ mode: 'ask', lists, args: { command: 'git status --short' } })).toBe(false)
    expect(asks({ mode: 'ask', lists, args: { command: 'git status:x' } })).toBe(true)
    // 选项插在中间就不是那个前缀 —— 不做顺序无关的聪明匹配
    expect(asks({ mode: 'ask', lists, args: { command: 'git --no-pager status' } })).toBe(true)
  })

  it('白名单要求每个分段都命中:只看第一段是最省事的绕过方式', () => {
    const lists: PermissionLists = { allow: ['ls'], deny: [] }
    expect(asks({ mode: 'ask', lists, args: { command: 'ls; rm -rf ~' } })).toBe(true)
    // 管道下游没在册就照问:名单是逐段授权的
    expect(asks({ mode: 'ask', lists, args: { command: 'ls | wc -l' } })).toBe(true)
    expect(
      asks({
        mode: 'ask',
        lists: { allow: ['ls', 'wc'], deny: [] },
        args: { command: 'ls | wc -l' }
      })
    ).toBe(false)
  })

  it('工具名条目让整个工具免审', () => {
    const lists: PermissionLists = { allow: ['write_file'], deny: [] }
    expect(asks({ mode: 'ask', lists, toolName: 'write_file', args: { path: '/x/a' } })).toBe(false)
  })

  it('以 __ 结尾的条目是该 MCP server 的全部工具', () => {
    const lists: PermissionLists = { allow: ['github__'], deny: [] }
    expect(
      asks({ mode: 'ask', lists, toolName: 'github__search', isMcpTool: true, args: {} })
    ).toBe(false)
    expect(asks({ mode: 'ask', lists, toolName: 'slack__post', isMcpTool: true, args: {} })).toBe(
      true
    )
  })
})

describe('名单优先级:deny → allow → 档位表', () => {
  const both: PermissionLists = { allow: ['ls'], deny: ['ls'] }

  it('黑名单压过白名单', () => {
    expect(asks({ mode: 'ask', lists: both, args: { command: 'ls' } })).toBe(true)
  })

  it('黑名单压过完全访问:它是唯一在任何档位都拦得住的闸门', () => {
    const requirement = needsApproval(
      query({ mode: 'full', lists: { allow: [], deny: ['git'] }, args: { command: 'git push' } })
    )
    expect(requirement?.risk).toBe('listed')
    expect(requirement?.detail[0]).toContain('命中黑名单')
  })

  it('黑名单在解析不了的命令上仍生效:最危险的写法恰好是看不懂的那批', () => {
    // 分段匹配在这里会落空,退回原文匹配才拦得住
    expect(
      asks({
        mode: 'full',
        lists: { allow: [], deny: ['cat'] },
        args: { command: 'cat a > /etc/hosts' }
      })
    ).toBe(true)
  })

  it('白名单命中后不再看档位:配了名单还被追问等于名单没配', () => {
    expect(asks({ mode: 'ask', lists: { allow: ['run_command'], deny: [] }, args: {} })).toBe(false)
  })
})

describe('给用户的文案只用陈述句', () => {
  it('summary 与 detail 不出现「请 / 务必 / 记得」:这些内容也可能被复制进对话', () => {
    const cases: Partial<ApprovalQuery>[] = [
      { args: { command: 'rm -rf build' } },
      { toolName: 'write_file', args: { path: '/x/a.md', content: 'a' } },
      { toolName: 'github__create_issue', isMcpTool: true, args: {} }
    ]
    for (const item of cases) {
      const requirement = needsApproval(query({ mode: 'ask', ...item }))
      const text = [requirement?.summary ?? '', ...(requirement?.detail ?? [])].join('\n')
      for (const word of ['请', '务必', '记得', '不要']) expect(text).not.toContain(word)
    }
  })

  it('条目形状的说明覆盖三种形状', () => {
    expect(LIST_ENTRY_SHAPES.join('\n')).toContain('token 边界')
    expect(LIST_ENTRY_SHAPES.join('\n')).toContain('server 前缀')
    expect(LIST_ENTRY_SHAPES).toHaveLength(3)
  })
})

describe('收紧立即、放宽下一轮', () => {
  it('取两者里更严的一档:正在跑的 run 可以被刹住,不能被当场放宽', () => {
    expect(stricterMode('full', 'ask')).toBe('ask')
    expect(stricterMode('ask', 'full')).toBe('ask')
    expect(stricterMode('auto', 'full')).toBe('auto')
    expect(stricterMode('full', 'full')).toBe('full')
  })
})
