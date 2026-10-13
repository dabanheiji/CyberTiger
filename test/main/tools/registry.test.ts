import { vi } from 'vitest'
import {
  builtinTools,
  createToolRunner,
  getAllTools,
  isVolatileTool,
  toChatCompletionTools
} from '../../../src/main/tools/registry'
import type { ToolDefinition } from '../../../src/main/tools/types'

/**
 * mcpManager 换成替身:getAllTools 会把它的工具接在内置之后,
 * 用例靠 mcpPool.tools 控制有哪些、什么顺序。
 */
const mcpPool = { tools: [] as string[] }

vi.mock('../../../src/main/mcp/manager', () => ({
  mcpManager: {
    // 惰性读取 mcpPool:用例运行时常量早已初始化,替身里只关心名字顺序
    getTools: (): ToolDefinition[] =>
      mcpPool.tools.map((name) => ({
        name,
        description: `工具 ${name}`,
        parameters: { type: 'object', properties: {} },
        execute: () => ''
      }))
  }
}))

function tool(
  name: string,
  execute: ToolDefinition['execute'],
  volatile?: boolean
): ToolDefinition {
  return {
    name,
    description: `工具 ${name}`,
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    volatile,
    execute
  }
}

/** 记下最后一次拿到的参数与上下文 */
interface Spy {
  definition: ToolDefinition
  args: Array<{ args: Record<string, unknown>; callId: string }>
}

function spyTool(name: string, result = 'ok', volatile?: boolean): Spy {
  const args: Spy['args'] = []
  return {
    args,
    definition: tool(
      name,
      (a, ctx) => {
        args.push({ args: a, callId: ctx.callId })
        return result
      },
      volatile
    )
  }
}

const ctx = { callId: 'call-1' }

describe('createToolRunner 的查找范围', () => {
  it('只认构造快照里的工具,幻觉出的名字被当作未知工具', async () => {
    const local = spyTool('mine')
    const runner = createToolRunner([local.definition])
    // 全局注册表里确实有 read_skill_file,但本 run 的快照没有 → 不可达
    const res = await runner.execute('read_skill_file', '{}', ctx)
    expect(res).toEqual({ ok: false, result: '未知工具 "read_skill_file",可用工具:mine' })
    expect(local.args).toHaveLength(0)
  })

  it('快照为空时任何调用都被拒绝', async () => {
    const runner = createToolRunner([])
    expect(await runner.execute('whatever', '{}', ctx)).toMatchObject({
      ok: false,
      result: '未知工具 "whatever",可用工具:'
    })
  })

  it('definitions 就是构造时那份快照', () => {
    const local = spyTool('mine')
    expect(createToolRunner([local.definition]).definitions).toEqual([local.definition])
  })
})

describe('参数校验', () => {
  it('空参数按无参数调用,传入空对象', async () => {
    const local = spyTool('mine')
    const runner = createToolRunner([local.definition])
    expect((await runner.execute('mine', '   ', ctx)).ok).toBe(true)
    expect(local.args[0].args).toEqual({})
  })

  it('合法对象原样解析后交给工具', async () => {
    const local = spyTool('mine')
    const runner = createToolRunner([local.definition])
    await runner.execute('mine', '{"q":"北京","extra":1}', ctx)
    expect(local.args[0].args).toEqual({ q: '北京', extra: 1 })
  })

  it('非法 JSON 不执行工具,把原文写进错误说明', async () => {
    const local = spyTool('mine')
    const runner = createToolRunner([local.definition])
    expect(await runner.execute('mine', '{"q":', ctx)).toEqual({
      ok: false,
      result: '参数不是合法的 JSON:{"q":'
    })
    expect(local.args).toHaveLength(0)
  })

  it('JSON 数组与标量都不是合法参数', async () => {
    const local = spyTool('mine')
    const runner = createToolRunner([local.definition])
    for (const raw of ['[1,2]', '"text"', '42', 'null']) {
      expect(await runner.execute('mine', raw, ctx)).toEqual({
        ok: false,
        result: '参数必须是 JSON 对象'
      })
    }
    expect(local.args).toHaveLength(0)
  })

  it('把调用上下文里的 callId 透传给工具', async () => {
    const local = spyTool('mine')
    const runner = createToolRunner([local.definition])
    await runner.execute('mine', '{}', { callId: 'call-42' })
    expect(local.args[0].callId).toBe('call-42')
  })
})

describe('执行失败一律转成可读说明', () => {
  it('工具抛 Error 时返回 ok=false 与 message', async () => {
    const runner = createToolRunner([
      tool('boom', () => {
        throw new Error('目录不存在')
      })
    ])
    expect(await runner.execute('boom', '{}', ctx)).toEqual({
      ok: false,
      result: '目录不存在'
    })
  })

  it('抛出非 Error 时按字符串处理', async () => {
    const runner = createToolRunner([
      tool('boom', () => {
        throw '直接抛了个字符串'
      })
    ])
    expect(await runner.execute('boom', '{}', ctx)).toEqual({
      ok: false,
      result: '直接抛了个字符串'
    })
  })

  it('异步工具等待完成后再返回结果', async () => {
    const runner = createToolRunner([
      tool('slow', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return '晚到的结果'
      })
    ])
    expect(await runner.execute('slow', '{}', ctx)).toEqual({ ok: true, result: '晚到的结果' })
  })

  it('异步 reject 同样被捕获', async () => {
    const runner = createToolRunner([
      tool('boom', async () => Promise.reject(new Error('rejected')))
    ])
    expect(await runner.execute('boom', '{}', ctx)).toEqual({ ok: false, result: 'rejected' })
  })

  it('工具返回空字符串仍是成功', async () => {
    const runner = createToolRunner([tool('empty', () => '')])
    expect(await runner.execute('empty', '{}', ctx)).toEqual({ ok: true, result: '' })
  })
})

describe('isVolatileTool', () => {
  const definitions = [
    spyTool('get_current_time', 'now', true).definition,
    spyTool('load_skill', 'body').definition
  ]

  it('只有显式声明 volatile 的工具算易变', () => {
    expect(isVolatileTool('get_current_time', definitions)).toBe(true)
    expect(isVolatileTool('load_skill', definitions)).toBe(false)
  })

  it('未知工具按不易变处理', () => {
    expect(isVolatileTool('not_here', definitions)).toBe(false)
  })
})

describe('toChatCompletionTools', () => {
  it('转成 OpenAI 的 function 结构,不带 execute', () => {
    const local = spyTool('mine', 'r', true)
    const [item] = toChatCompletionTools([local.definition])
    expect(item).toEqual({
      type: 'function',
      function: {
        name: 'mine',
        description: '工具 mine',
        parameters: { type: 'object', properties: { q: { type: 'string' } } }
      }
    })
    expect(JSON.stringify(item)).not.toContain('execute')
  })

  it('空工具集给出空数组,模型就不会看到 tools 字段', () => {
    expect(toChatCompletionTools([])).toEqual([])
    expect(createToolRunner([]).toChatCompletionTools()).toEqual([])
  })
})

describe('getAllTools 的稳定顺序', () => {
  it('MCP 部分按名字排序,与 server 的连接顺序无关', () => {
    mcpPool.tools = ['zeta_tool', 'alpha_tool', 'middle_tool']
    const names = getAllTools().map((t) => t.name)
    expect(names.slice(builtinTools.length)).toEqual(['alpha_tool', 'middle_tool', 'zeta_tool'])
    // 内置部分保持声明序:它不随外部状态变,顺手重排只会白白打掉请求前缀
    expect(names.slice(0, builtinTools.length)).toEqual(builtinTools.map((t) => t.name))
  })

  it('重连导致顺序变化后,同一份工具集仍拼出同一个名字序列', () => {
    mcpPool.tools = ['a', 'b']
    const first = getAllTools()
      .map((t) => t.name)
      .join(',')
    mcpPool.tools = ['b', 'a']
    expect(
      getAllTools()
        .map((t) => t.name)
        .join(',')
    ).toBe(first)
  })

  it('没有 MCP 连接时只剩内置工具', () => {
    mcpPool.tools = []
    expect(getAllTools().map((t) => t.name)).toEqual(builtinTools.map((t) => t.name))
  })
})
