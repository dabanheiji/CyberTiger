import {
  buildHookFile,
  DEFAULT_HOOK_TIMEOUT_MS,
  parseHookFile
} from '../../../src/main/hooks/parser'
import { HOOK_EVENTS } from '../../../src/main/hooks/types'
import type { HookDraft } from '../../../src/main/hooks/types'

const DIR = '/Users/tester/.cybertiger/hooks/notify-on-answer'

function hookFile(front: string, body = '给人看的说明'): string {
  return `---\n${front}\n---\n${body}`
}

const MINIMAL =
  'name: notify-on-answer\ndescription: 回答结束后发一条系统通知\nevent: afterAgent\ncommand: /usr/bin/osascript'
// 变体各自补一个键,所以基线里不能已经有那一个:YAML 的重复键会在解析阶段就报错,
// 于是「测的是字段校验」的用例会变成「测的是 frontmatter 解析器」
const NO_EVENT =
  'name: notify-on-answer\ndescription: 回答结束后发一条系统通知\ncommand: /usr/bin/osascript'
const NO_COMMAND =
  'name: notify-on-answer\ndescription: 回答结束后发一条系统通知\nevent: afterAgent'

/** 六个事件都合法:这份清单一旦被收窄,老用户的声明会在下次启动时报错 */
describe('parseHookFile:必填字段', () => {
  it('解析最小合法文件,未声明的键落到各自的保守缺省', () => {
    expect(parseHookFile(hookFile(MINIMAL), DIR)).toEqual({
      name: 'notify-on-answer',
      description: '回答结束后发一条系统通知',
      event: 'afterAgent',
      command: '/usr/bin/osascript',
      args: [],
      matcher: [],
      sandboxed: false,
      timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
      once: false,
      doc: '给人看的说明',
      dir: DIR,
      // 启停是应用侧状态:磁盘上写下来即「用户要它」,没勾回来由 registry 关掉
      enabled: true
    })
  })

  it('六个事件字面量都能解析', () => {
    for (const event of HOOK_EVENTS) {
      expect(parseHookFile(hookFile(`${NO_EVENT}\nevent: ${event}`), DIR).event).toBe(event)
    }
  })

  it('event 认不出来时报错并列出全部六个:只说「不合法」用户不知道该填什么', () => {
    expect(() => parseHookFile(hookFile(`${NO_EVENT}\nevent: beforeAnswer`), DIR)).toThrow(
      HOOK_EVENTS.join(' / ')
    )
  })

  it('缺 command 就报错:那是在这台机器上真实执行的可执行程序,不能猜', () => {
    expect(() =>
      parseHookFile(hookFile('name: a-hook\ndescription: d\nevent: beforeAgent'), '/tmp/a-hook')
    ).toThrow('缺少 command')
  })

  it('name 必须与目录名一致:目录才是身份', () => {
    expect(() => parseHookFile(hookFile(MINIMAL), '/x/other-name', 'other-name')).toThrow(
      '必须与目录名 "other-name" 一致'
    )
  })
})

describe('parseHookFile:安全字段不猜', () => {
  it('sandboxed 写成字符串就报错,而不是按「有值即开启」读', () => {
    expect(() => parseHookFile(hookFile(`${MINIMAL}\nsandboxed: "false"`), DIR)).toThrow(
      'sandboxed 必须是 true 或 false'
    )
  })

  it('sandboxed: no(YAML 里是假)也报错:把该进边界的钩子放出去是不可逆的错法', () => {
    expect(() => parseHookFile(hookFile(`${MINIMAL}\nsandboxed: no`), DIR)).toThrow(
      'sandboxed 必须是 true 或 false'
    )
  })

  it('once 同样只认真假', () => {
    expect(() => parseHookFile(hookFile(`${MINIMAL}\nonce: 1`), DIR)).toThrow(
      'once 必须是 true 或 false'
    )
  })

  it('timeout 要正数且不超上限:钩子是同步挡在流水线上的', () => {
    expect(parseHookFile(hookFile(`${MINIMAL}\ntimeout: 3000`), DIR).timeoutMs).toBe(3000)
    expect(() => parseHookFile(hookFile(`${MINIMAL}\ntimeout: 0`), DIR)).toThrow('正数毫秒')
    expect(() => parseHookFile(hookFile(`${MINIMAL}\ntimeout: 120000`), DIR)).toThrow(
      'timeout 不能超过 60000 毫秒'
    )
  })
})

describe('parseHookFile:数组与长度上限', () => {
  it('args 每条都当参数交给 spawn,所以不做任何拆分', () => {
    const parsed = parseHookFile(
      hookFile(`${MINIMAL}\nargs: ['-e', 'display notification "x"']`),
      DIR
    )
    expect(parsed.args).toEqual(['-e', 'display notification "x"'])
  })

  it('args / matcher 超上限报错:上限是「这条声明还能被读完」的保证', () => {
    expect(() =>
      parseHookFile(hookFile(`${MINIMAL}\nargs: [${Array(65).fill('"a"').join(',')}]`), DIR)
    ).toThrow('args 最多 64 条')
    expect(() =>
      parseHookFile(hookFile(`${MINIMAL}\nmatcher: [${Array(101).fill('"a"').join(',')}]`), DIR)
    ).toThrow('matcher 最多 100 条')
  })

  it('args 含非字符串报错:数字会被静默转成 "1" 而参数本来可能是 01', () => {
    expect(() => parseHookFile(hookFile(`${MINIMAL}\nargs: [1]`), DIR)).toThrow(
      'args 只能包含字符串'
    )
  })

  it('command 超长报错:那条路径不可能真的存在', () => {
    expect(() =>
      parseHookFile(hookFile(`${NO_COMMAND}\ncommand: ${'p'.repeat(1025)}`), DIR)
    ).toThrow('command 不能超过 1024 个字符')
  })

  it('正文说明超长报错', () => {
    expect(() => parseHookFile(hookFile(MINIMAL, '相'.repeat(8001)), DIR)).toThrow(
      '正文说明不能超过'
    )
  })
})

describe('parseHookFile:正文不参与任何判定', () => {
  it('正文里写 event / block 也不会改变解析结果', () => {
    const parsed = parseHookFile(
      hookFile(MINIMAL, '这段话里有 event: beforeToolCall 和 {"block": true} 两个字符串'),
      DIR
    )
    expect(parsed.event).toBe('afterAgent')
    expect(parsed.doc).toContain('"block": true')
  })
})

const FULL_DRAFT: HookDraft = {
  name: 'block-force-push',
  description: '拦掉任何 git push --force',
  event: 'beforeToolCall',
  command: 'hook.mjs',
  args: ['--strict'],
  matcher: ['run_command:git push'],
  sandboxed: true,
  timeout: 5000,
  once: true,
  doc: '参数里带 --strict,所以用 args 而不是拼进 command。'
}

describe('buildHookFile', () => {
  it('写下的文件与草稿往返等值:界面放过、落盘后才报错是最难查的一种失败', () => {
    const { content } = buildHookFile(FULL_DRAFT)
    const parsed = parseHookFile(content, '/h/block-force-push', 'block-force-push')
    expect(parsed).toMatchObject({
      name: FULL_DRAFT.name,
      description: FULL_DRAFT.description.trim(),
      event: FULL_DRAFT.event,
      command: FULL_DRAFT.command,
      args: FULL_DRAFT.args,
      matcher: FULL_DRAFT.matcher,
      sandboxed: true,
      timeoutMs: 5000,
      once: true,
      doc: FULL_DRAFT.doc
    })
  })

  it('同一个草稿两次保存逐字节相同:界面靠这个判断「有没有改动」', () => {
    expect(buildHookFile(FULL_DRAFT).content).toBe(buildHookFile(FULL_DRAFT).content)
  })

  it('空 args / matcher 不写进文件:`args: []` 读起来像漏填', () => {
    const { content } = buildHookFile({
      name: 'simple',
      description: 'd',
      event: 'beforeAgent',
      command: 'node',
      args: [],
      matcher: []
    })
    expect(content).not.toContain('args:')
    expect(content).not.toContain('matcher:')
  })

  it('草稿走同一套校验:event 认不出来时在落盘之前就报错', () => {
    expect(() =>
      buildHookFile({ ...FULL_DRAFT, event: 'onAnswer' as unknown as HookDraft['event'] })
    ).toThrow('event "onAnswer" 认不出来')
  })

  it('description 两端空白去掉后写回', () => {
    const { content } = buildHookFile({ ...FULL_DRAFT, description: '  带空白  ' })
    expect(content).toContain('description: 带空白')
  })
})
