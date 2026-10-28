import os from 'node:os'
import path from 'node:path'
import {
  LOG_SNIPPET_CHARS,
  MAX_HOOK_PAYLOAD_BYTES,
  MAX_HOOK_REPLY_BYTES,
  MAX_NOTES_PER_STEP,
  NOTE_CHARS,
  REASON_CHARS,
  buildPayload,
  describeRunBlock,
  describeToolBlock,
  readReply,
  resolveHookCommand,
  serializePayload
} from '../../../src/main/hooks/contract'
import type { HookPayloadContext, HookTrigger } from '../../../src/main/hooks/contract'
import { DEFAULT_HOOK_TIMEOUT_MS, parseHookFile } from '../../../src/main/hooks/parser'
import type { HookMeta } from '../../../src/main/hooks/types'
import type { RunScope } from '../../../src/main/chat/dto'
import type { ChatCompletionMessage } from '../../../src/main/chat/llm'

const DIR = '/Users/tester/Library/Application Support/cybertiger/hooks/demo'

function meta(fields: Partial<HookMeta> = {}): HookMeta {
  return {
    name: 'demo',
    description: '演示',
    event: 'beforeAgent',
    command: 'node',
    args: [],
    matcher: [],
    sandboxed: false,
    timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    once: false,
    doc: '',
    dir: DIR,
    enabled: true,
    ...fields
  }
}

const MAIN_SCOPE: RunScope = {
  conversationId: 'conv-1',
  runId: 'run-1',
  agent: '',
  parentCallId: '',
  depth: 0
}

const SUB_SCOPE: RunScope = {
  conversationId: 'conv-1',
  runId: 'run-2',
  agent: 'code-reviewer',
  parentCallId: 'call-9',
  depth: 1
}

function context(
  trigger: HookTrigger,
  fields: Partial<HookPayloadContext> = {}
): HookPayloadContext {
  return {
    hook: meta({ event: trigger.event }),
    scope: MAIN_SCOPE,
    workspace: '/Users/tester/project',
    boundary: 'unrestricted',
    request: '帮我把这个仓库跑起来',
    maxSteps: 10,
    trigger,
    ...fields
  }
}

function longText(chars: number, fill = '长'): string {
  return fill.repeat(chars)
}

describe('buildPayload:公共那一段', () => {
  it('六个事件都带上「我在哪儿、我能写到哪儿」这两句', () => {
    const payload = buildPayload(context({ event: 'beforeAgent' }))
    expect(payload).toMatchObject({
      contract: 1,
      event: 'beforeAgent',
      hook: 'demo',
      dir: DIR,
      workspace: '/Users/tester/project',
      boundary: 'unrestricted'
    })
  })

  it('run 那一段直接取自 RunScope:父子用同一份真值,所以不另加 isSubAgent 布尔', () => {
    const payload = buildPayload(context({ event: 'beforeAgent' }, { scope: SUB_SCOPE }))
    expect(payload.run).toEqual({
      conversationId: 'conv-1',
      runId: 'run-2',
      agent: 'code-reviewer',
      depth: 1,
      parentCallId: 'call-9',
      step: 0,
      maxSteps: 10
    })
  })

  it('beforeAgent 的 data 是空对象:此刻还没有任何出站请求,不是漏了字段', () => {
    expect(buildPayload(context({ event: 'beforeAgent' })).data).toEqual({})
  })

  it('未选工作空间时 workspace 是空串而不是 null:脚本比对空串比比对 null 直白', () => {
    expect(buildPayload(context({ event: 'beforeAgent' }, { workspace: '' })).workspace).toBe('')
  })

  it('本轮请求原文超长时被切并且点名', () => {
    const payload = buildPayload(context({ event: 'beforeAgent' }, { request: longText(2500) }))
    expect(payload.request).toHaveLength(2000)
    expect(payload.data.truncated).toEqual(['request'])
  })
})

describe('buildPayload:beforeRequest 给整份出站消息', () => {
  const messages: ChatCompletionMessage[] = [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '帮我把这个仓库跑起来' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'run_command', arguments: '{"command":"ls"}' }
        }
      ]
    },
    { role: 'tool', content: 'a.ts\nb.ts', tool_call_id: 'c1' },
    { role: 'user', content: '[目标锚定] 本轮要回应的那句话' }
  ]

  it('data.messages 与输入数组逐字节相同:拿到的是真的即将发出去的那一份', () => {
    const payload = buildPayload(
      context({
        event: 'beforeRequest',
        step: 3,
        maxSteps: 10,
        isFinalStep: false,
        tools: ['run_command', 'read_file'],
        messages
      })
    )
    expect(JSON.stringify(payload.data.messages)).toBe(JSON.stringify(messages))
  })

  it('几百 KB 的正文也不切、不点名截断:改写权要求原料是完整的', () => {
    const fat: ChatCompletionMessage[] = [
      { role: 'system', content: longText(300_000) },
      { role: 'user', content: '问题' }
    ]
    const payload = buildPayload(
      context({
        event: 'beforeRequest',
        step: 1,
        maxSteps: 10,
        isFinalStep: false,
        tools: [],
        messages: fat
      })
    )
    const back = payload.data.messages as ChatCompletionMessage[]
    expect(JSON.stringify(back)).toBe(JSON.stringify(fat))
    expect(payload.data.truncated).toBeUndefined()
  })

  it('只给工具名不给工具定义:改写工具集是另一件事,而名字数组短且够用', () => {
    const payload = buildPayload(
      context({
        event: 'beforeRequest',
        step: 1,
        maxSteps: 10,
        isFinalStep: true,
        tools: ['read_file'],
        messages: []
      })
    )
    expect(payload.data.tools).toEqual(['read_file'])
    expect(payload.data.isFinalStep).toBe(true)
    expect(Object.keys(payload.data).sort()).toEqual(
      ['isFinalStep', 'maxSteps', 'messages', 'step', 'tools'].sort()
    )
  })

  it('run.step 与 data.step 同一个数:两处都来自本次调用,不会漂', () => {
    const payload = buildPayload(
      context({
        event: 'beforeRequest',
        step: 7,
        maxSteps: 10,
        isFinalStep: false,
        tools: [],
        messages: []
      })
    )
    expect(payload.run.step).toBe(7)
    expect(payload.data.step).toBe(7)
  })
})

describe('buildPayload:另外五个事件的 data', () => {
  it('afterRequest 不给整份消息:after* 没有改写权,完整数组只为审计,而审计归 JSONL', () => {
    const payload = buildPayload(
      context({
        event: 'afterRequest',
        step: 2,
        content: '已经跑起来了',
        reasoning: '',
        calls: [],
        usage: { prompt: 10, completion: 3, estimated: false },
        model: 'qwen3.5:4b'
      })
    )
    expect(payload.data.messages).toBeUndefined()
    expect(payload.data.model).toBe('qwen3.5:4b')
  })

  it('超长的正文与推理各切各的并都点名', () => {
    const payload = buildPayload(
      context({
        event: 'afterRequest',
        step: 2,
        content: longText(9000),
        reasoning: longText(3000),
        calls: [{ id: 'c1', name: 'run_command', arguments: longText(5000) }],
        usage: null,
        model: 'm'
      })
    )
    expect(payload.data.content).toHaveLength(8000)
    expect(payload.data.reasoning).toHaveLength(2000)
    expect(payload.data.truncated).toEqual(['content', 'reasoning', 'calls'])
  })

  it('beforeToolCall 同时给原始串与解析结果:被模型写坏的那条调用也要看得见', () => {
    const payload = buildPayload(
      context({
        event: 'beforeToolCall',
        step: 1,
        call: { id: 'c1', name: 'write_file', arguments: '{"path":"notes.md"' },
        args: null,
        workspaceRelative: 'notes.md'
      })
    )
    expect(payload.data.args).toBeNull()
    expect((payload.data.call as { arguments: string }).arguments).toContain('"path"')
  })

  it('afterToolCall 给结论与耗时,不给消息', () => {
    const payload = buildPayload(
      context({
        event: 'afterToolCall',
        step: 1,
        call: { id: 'c1', name: 'run_command', arguments: '{"command":"ls"}' },
        ok: true,
        result: longText(5000),
        durationMs: 42
      })
    )
    expect(payload.data.ok).toBe(true)
    expect(payload.data.durationMs).toBe(42)
    expect(payload.data.result).toHaveLength(4000)
    expect(payload.data.truncated).toEqual(['result'])
  })

  it('afterAgent 带中止与错误,让钩子自己判这一轮是怎么收的', () => {
    const payload = buildPayload(
      context({ event: 'afterAgent', step: 4, finalContent: '', aborted: true, error: '' })
    )
    expect(payload.data).toEqual({ finalContent: '', aborted: true, error: '' })
    expect(payload.run.step).toBe(4)
  })
})

describe('serializePayload', () => {
  it('正常 payload 给出字节数且不超限', () => {
    const result = serializePayload(buildPayload(context({ event: 'beforeAgent' })))
    expect(result.tooLarge).toBe(false)
    expect(JSON.parse(result.json).event).toBe('beforeAgent')
  })

  it('超过上限只标 tooLarge,不截断:一段被切的 JSON 让钩子白跑一个进程', () => {
    const huge: ChatCompletionMessage[] = [
      { role: 'user', content: longText(MAX_HOOK_PAYLOAD_BYTES + 10, 'a') }
    ]
    const result = serializePayload(
      buildPayload(
        context({
          event: 'beforeRequest',
          step: 1,
          maxSteps: 10,
          isFinalStep: false,
          tools: [],
          messages: huge
        })
      )
    )
    expect(result.tooLarge).toBe(true)
    expect(result.bytes).toBeGreaterThan(MAX_HOOK_PAYLOAD_BYTES)
  })
})

describe('resolveHookCommand:相对路径按钩子目录,cwd 恒为钩子目录', () => {
  it('带 ./ 的相对路径落进钩子目录', () => {
    expect(resolveHookCommand(meta({ command: './hook.mjs' }))).toEqual({
      argv: [path.join(DIR, 'hook.mjs')],
      file: path.join(DIR, 'hook.mjs'),
      cwd: DIR
    })
  })

  it('绝对路径原样', () => {
    expect(resolveHookCommand(meta({ command: '/usr/bin/osascript' })).file).toBe(
      '/usr/bin/osascript'
    )
  })

  it('`~` 前缀展开到家目录', () => {
    expect(resolveHookCommand(meta({ command: '~/bin/hook.sh' })).file).toBe(
      path.join(os.homedir(), 'bin', 'hook.sh')
    )
  })

  it('裸命令名交给 PATH 查找:file 留空,界面据此写「按 PATH 查找」', () => {
    const resolved = resolveHookCommand(meta({ command: 'node', args: ['-v'] }))
    expect(resolved.file).toBe('')
    expect(resolved.argv).toEqual(['node', '-v'])
    expect(resolved.cwd).toBe(DIR)
  })

  it('带扩展名却没有分隔符的 `hook.mjs` 也按钩子目录解析:脚本跟着声明放在一起才是能读懂的形状', () => {
    expect(resolveHookCommand(meta({ command: 'hook.mjs' })).file).toBe(path.join(DIR, 'hook.mjs'))
  })

  it('代价写明白:名字里有点的 PATH 程序会被当成文件,那一类要写绝对路径', () => {
    expect(resolveHookCommand(meta({ command: 'pip3.11' })).file).toBe(path.join(DIR, 'pip3.11'))
    expect(resolveHookCommand(meta({ command: 'python3' })).file).toBe('')
  })

  it('盘符开头的 Windows 绝对路径算路径而不是命令名(在 mac 上 resolve 的结果不有意义,只断它走了路径那一支)', () => {
    const resolved = resolveHookCommand(meta({ command: 'C:\\tools\\hook.exe' }))
    expect(resolved.file).not.toBe('')
    expect(resolved.argv[0]).toBe(resolved.file)
  })

  it('args 原样排在可执行文件之后,不做任何拆分', () => {
    const resolved = resolveHookCommand(
      meta({ command: 'osascript', args: ['-e', 'display notification "x"'] })
    )
    expect(resolved.argv).toEqual(['osascript', '-e', 'display notification "x"'])
  })
})

describe('readReply:合法回执', () => {
  it('读到 block / reason / note / message 各归各位', () => {
    const reply = readReply(
      JSON.stringify({
        block: true,
        reason: '这条命令会强推到 main',
        note: '本轮是发布前检查',
        message: '已提醒'
      }),
      '',
      'beforeToolCall'
    )
    expect(reply.problem).toBe('')
    expect(reply.block).toBe(true)
    expect(reply.reason).toBe('这条命令会强推到 main')
    expect(reply.note).toBe('本轮是发布前检查')
    expect(reply.log).toBe('已提醒')
    expect(reply.ignored).toEqual([])
  })

  it('前后空白与换行不影响解析:脚本爱 console.log(JSON.stringify(x)) 后面带个换行', () => {
    expect(readReply('\n  {"note":"n"}  \n', '', 'beforeAgent').note).toBe('n')
  })

  it('只有 === true 才算否决:写歪成字符串或 1 都读成「不拦」', () => {
    for (const value of ['true', 1, 'yes', 0, null]) {
      expect(readReply(JSON.stringify({ block: value }), '', 'beforeAgent').block).toBe(false)
    }
  })

  it('before* 之外的键在这个事件上不读:进了 ignored 而不是悄悄吞掉', () => {
    const reply = readReply(
      JSON.stringify({ block: true, messages: [{ role: 'user', content: 'x' }] }),
      '',
      'afterAgent'
    )
    expect(reply.block).toBe(false)
    expect(reply.rewrite).toBeNull()
    expect(reply.ignored).toEqual(['block', 'messages'])
  })

  it('改写权只给 beforeRequest:同一段 messages 在 beforeToolCall 上被忽略', () => {
    const payload = JSON.stringify({ messages: [{ role: 'user', content: 'x' }] })
    expect(readReply(payload, '', 'beforeToolCall').rewrite).toBeNull()
    expect(readReply(payload, '', 'beforeRequest').rewrite).toHaveLength(1)
  })

  it('退出码非 0 但 stdout 可解析时照它:退出码表达失败、stdout 表达理由', () => {
    const reply = readReply(
      JSON.stringify({ block: true, reason: '不该改这个文件' }),
      '脚本内部有个警告',
      'beforeToolCall',
      {
        exitCode: 2
      }
    )
    expect(reply.block).toBe(true)
    expect(reply.exitCode).toBe(2)
    expect(reply.problem).toBe('')
    // 那条 stderr 留在日志里,不然「它自己认为哪儿出了错」这条线索就没了
    expect(reply.out).toContain('脚本内部有个警告')
  })

  it('reason 与 note 各有上限并切在那里,不把钩子的输出变成模型的第二个上下文', () => {
    const reply = readReply(
      JSON.stringify({
        block: true,
        reason: longText(REASON_CHARS + 500, 'r'),
        note: longText(NOTE_CHARS + 500, 'n')
      }),
      '',
      'beforeAgent'
    )
    expect(reply.reason).toHaveLength(REASON_CHARS)
    expect(reply.note).toHaveLength(NOTE_CHARS)
  })

  it('note 写成数字不算合法字符串:整段作废比「读成 42」好查', () => {
    const reply = readReply(JSON.stringify({ note: 42 }), '', 'beforeAgent')
    expect(reply.note).toBe('')
    expect(reply.ignored).toEqual(['note'])
  })
})

describe('readReply:没有结论的那些情形', () => {
  it('空输出即无决策', () => {
    expect(readReply('', '', 'beforeAgent').problem).toContain('没有输出')
  })

  it('非 0 退出码且没有输出时把退出码写进理由:一眼看出是脚本自己挂了', () => {
    const reply = readReply('', 'boom', 'beforeAgent', { exitCode: 1 })
    expect(reply.problem).toContain('退出码 1')
    expect(reply.out).toBe('boom')
  })

  it('半截 JSON 是「没有结论」而不是「短一点的结论」', () => {
    expect(readReply('{"block": tr', '', 'beforeAgent').problem).toContain('不是合法的 JSON')
  })

  it('数组与标量都不算回执', () => {
    expect(readReply('[1,2]', '', 'beforeAgent').problem).toContain('不是一个对象')
    expect(readReply('"ok"', '', 'beforeAgent').problem).toContain('不是一个对象')
    expect(readReply('null', '', 'beforeAgent').problem).toContain('不是一个对象')
  })

  it('坏输出时把原文抄进日志,最多 2000 字:排查靠这一格,但不能把会话原文抄进那份文件', () => {
    const reply = readReply('{"block": tr' + longText(5000, 'x'), '', 'beforeAgent')
    expect(reply.out).toHaveLength(LOG_SNIPPET_CHARS)
  })

  it('超上限时整段作废,理由里写出是哪一档上限', () => {
    const small = readReply('', '', 'beforeToolCall', { overflow: true })
    expect(small.problem).toContain(String(MAX_HOOK_REPLY_BYTES))
    const rewrite = readReply('', '', 'beforeRequest', { overflow: true })
    expect(rewrite.problem).toContain('8388608')
  })

  it('溢出与「什么都没输出」是两件事,靠这个标志分开', () => {
    expect(readReply('', '', 'beforeAgent', { overflow: true }).problem).toContain('上限')
    expect(readReply('', '', 'beforeAgent').problem).toBe('没有输出')
  })
})

describe('给模型看的那两句否决', () => {
  /** 审批那三句说的都是「没有人点头」;钩子那句是「一条规则拦住了它」,混起来会让模型以为用户反对 */
  const approvalSentences = [
    '用户拒绝了这次操作,操作没有进行。',
    '[本轮已中止,没有做出审批,操作没有进行]',
    '[等待审批超时,没有人做出决定,操作没有进行]'
  ]

  it('三句审批文案两两不同,且钩子那句不含「用户拒绝」字样', () => {
    const tool = describeToolBlock('guard', '')
    const run = describeRunBlock('guard', '')
    const all = [...approvalSentences, tool, run]
    expect(new Set(all).size).toBe(all.length)
    for (const sentence of [tool, run]) {
      expect(sentence).not.toContain('用户拒绝')
      expect(sentence).toContain('钩子 guard')
    }
  })

  it('默认那句是陈述句、说清没执行,不含祈使', () => {
    expect(describeToolBlock('guard', '')).toBe('[被钩子 guard 拦下,这次调用没有执行]')
    expect(describeRunBlock('guard', '')).toBe('[被钩子 guard 拦下,本轮没有继续]')
    expect(describeToolBlock('guard', '会改到 main')).toBe('[被钩子 guard 拦下:会改到 main]')
    for (const sentence of [describeToolBlock('g', 'x'), describeRunBlock('g', 'x')]) {
      expect(sentence).not.toMatch(/请|务必|记得|重新调用/)
    }
  })

  it('一步最多采纳八条说明:没有上限时碎嘴的钩子会把裁剪推进缩写档,开始裁真正的工具结果', () => {
    expect(MAX_NOTES_PER_STEP).toBe(8)
  })
})

describe('HOOK.md 与 payload 的接缝', () => {
  it('声明里的 command 与 args 一路原样进 argv,中间没有 shell', () => {
    const parsed = parseHookFile(
      '---\nname: demo\ndescription: d\nevent: beforeToolCall\ncommand: ./hook.mjs\nargs: ["-e", "--verbose flag"]\n---\n\n说明\n',
      DIR,
      'demo'
    )
    expect(resolveHookCommand(parsed).argv).toEqual([
      path.join(DIR, 'hook.mjs'),
      '-e',
      '--verbose flag'
    ])
  })
})
