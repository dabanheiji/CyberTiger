import {
  HOOK_MATCHER_SHAPES,
  hookCommandOf,
  matcherApplies,
  matchesHook
} from '../../../src/main/hooks/matcher'
import type { HookMatchTarget } from '../../../src/main/hooks/matcher'
import { HOOK_EVENTS } from '../../../src/main/hooks/types'

function tool(name: string, args: Record<string, unknown>): HookMatchTarget {
  return { toolName: name, args }
}

function runCommand(command: string): HookMatchTarget {
  return tool('run_command', { command })
}

describe('matcherApplies:只有两个事件带「哪次调用」这个概念', () => {
  it('工具事件适用,run / request 事件不适用', () => {
    const applies = HOOK_EVENTS.filter(matcherApplies)
    expect(applies).toEqual(['beforeToolCall', 'afterToolCall'])
  })

  it('其余四个事件上 matcher 一律不适用:那些时机没有「哪一次调用」可管', () => {
    for (const event of HOOK_EVENTS.filter((e) => !matcherApplies(e))) {
      expect(matcherApplies(event)).toBe(false)
    }
  })
})

describe('matchesHook:空 matcher 与工具名', () => {
  it('留空即每一次调用都触发', () => {
    expect(matchesHook([], runCommand('git push'))).toBe(true)
    expect(matchesHook([], tool('write_file', { path: 'a.md' }))).toBe(true)
  })

  it('工具名条目精确匹配,不认前缀', () => {
    expect(matchesHook(['write_file'], tool('write_file', {}))).toBe(true)
    expect(matchesHook(['write'], tool('write_file', {}))).toBe(false)
  })

  it('以 __ 结尾的条目匹配该 MCP server 的全部工具', () => {
    expect(matchesHook(['github__'], tool('github__create_issue', {}))).toBe(true)
    expect(matchesHook(['github__'], tool('gitlab__create_issue', {}))).toBe(false)
  })

  it('任一条目命中即触发:matcher 是「这条钩子管哪些调用」的并集', () => {
    expect(matchesHook(['read_file', 'write_file'], tool('write_file', {}))).toBe(true)
  })
})

describe('matchesHook:命令前缀按 token 边界', () => {
  it('命中带后续参数的同一前缀', () => {
    expect(matchesHook(['run_command:git push'], runCommand('git push --force'))).toBe(true)
  })

  it('不命中拼在同一词上的写法:那是一条别的命令', () => {
    expect(matchesHook(['run_command:git push'], runCommand('git pushstatus'))).toBe(false)
  })

  it('不命中选项插在中间的那条:顺序无关的聪明匹配没人猜得到', () => {
    expect(matchesHook(['run_command:git push'], runCommand('git --no-pager push'))).toBe(false)
  })

  it('命令前缀条目只对「这次调用真的带命令」的工具成立', () => {
    expect(matchesHook(['run_command:git push'], tool('write_file', { command: 'git push' }))).toBe(
      false
    )
  })

  it('形状不完整的条目(<工具名>: 后面空的)永不命中,免得一个笔误变成全命中', () => {
    expect(matchesHook(['run_command:'], runCommand('git push'))).toBe(false)
    expect(matchesHook([':git push'], runCommand('git push'))).toBe(false)
  })
})

describe('matchesHook:任一分段命中即触发(与审批白名单刻意相反)', () => {
  /**
   * 审批那侧要求**每个分段都命中**才免审(`tools/permission.ts` 的 `allSegmentsCovered`,
   * 那里保守的方向是「多问一次」)。这里反过来:拦 `git push` 的钩子在 `ls; git push --force`
   * 上必须也触发 —— 只看第一段等于给拦截开了一扇「前面先跑一条无害命令」的门,
   * 而那正是所有人绕开拦截会用的写法。改这一行之前先读这段。
   */
  it('一条无害命令挡不住后面那条真要拦的', () => {
    expect(matchesHook(['run_command:git push'], runCommand('ls; git push --force'))).toBe(true)
    expect(matchesHook(['run_command:git push'], runCommand('echo hi && git push'))).toBe(true)
  })

  it('管道与换行同样算分段', () => {
    expect(matchesHook(['run_command:git push'], runCommand('git push\n| cat'))).toBe(true)
    expect(matchesHook(['run_command:rm'], runCommand('echo x | rm -f x'))).toBe(true)
  })

  it('每个分段都不相干时不触发', () => {
    expect(matchesHook(['run_command:git push'], runCommand('ls; pwd'))).toBe(false)
  })

  it('命令看不懂(引号未闭合)时退回按原文做词边界匹配,仍然触发:「看不懂」不能当绕过手段', () => {
    expect(matchesHook(['run_command:git push'], runCommand('git push "未闭合'))).toBe(true)
    expect(matchesHook(['run_command:git push'], runCommand('echo "未闭合; git push'))).toBe(true)
  })

  it('退回原文时依旧讲 token 边界:git pushstatus 不是 git push', () => {
    expect(matchesHook(['run_command:git push'], runCommand('git pushstatus "未闭合'))).toBe(false)
  })

  it('解析得了的时候按分段判:引号里的字样不算命令', () => {
    expect(matchesHook(['run_command:git push'], runCommand('echo "git push"'))).toBe(false)
  })
})

describe('hookCommandOf:哪一次调用真的带命令', () => {
  it('run_command 取 command,两端空白去掉', () => {
    expect(hookCommandOf(runCommand('  git push  '))).toBe('git push')
  })

  it('background_job 缺 action 即 start:漏掉 action 也会真的启动一条命令', () => {
    expect(hookCommandOf(tool('background_job', { command: 'npm run build' }))).toBe(
      'npm run build'
    )
    expect(
      hookCommandOf(tool('background_job', { action: 'start', command: 'docker compose up' }))
    ).toBe('docker compose up')
  })

  it('background_job 的 list / logs / stop 不碰机器,因而没有命令可比', () => {
    expect(hookCommandOf(tool('background_job', { action: 'stop', job_id: '1' }))).toBe('')
  })

  it('background_job 上的命令前缀条目按同一规则命中 start', () => {
    expect(
      matchesHook(
        ['background_job:docker compose'],
        tool('background_job', { command: 'docker compose up -d' })
      )
    ).toBe(true)
    expect(
      matchesHook(
        ['background_job:docker compose'],
        tool('background_job', { action: 'logs', job_id: '2' })
      )
    ).toBe(false)
  })

  it('其余工具没有命令:空串', () => {
    expect(hookCommandOf(tool('read_file', { path: 'a' }))).toBe('')
  })
})

describe('HOOK_MATCHER_SHAPES:形状说明唯一一份', () => {
  it('五条形状都在,且把与审批名单的分歧写在界面上', () => {
    expect(HOOK_MATCHER_SHAPES).toHaveLength(5)
    expect(HOOK_MATCHER_SHAPES.join('\n')).toContain('任一分段命中')
    expect(HOOK_MATCHER_SHAPES.join('\n')).toContain('background_job')
  })
})
