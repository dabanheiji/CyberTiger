import {
  SUB_AGENT_MAX_STEPS,
  TASK_TOOL_NAME,
  createTaskTool,
  type SpawnRequest,
  type SubAgentSpawner
} from '../../../src/main/agent/task'
import { createToolRunner } from '../../../src/main/tools/registry'
import type { ToolContext } from '../../../src/main/tools/types'

const context: ToolContext = { callId: 'task-call-1' }

/** 记下 spawner 收到的请求,并固定返回一段结论 */
function makeSpawn(result = '子 Agent 的结论'): {
  requests: SpawnRequest[]
  spawn: SubAgentSpawner
} {
  const requests: SpawnRequest[] = []
  return {
    requests,
    spawn: async (req) => {
      requests.push(req)
      return result
    }
  }
}

describe('task 工具的参数暴露', () => {
  it('没有可选角色时完全不暴露 agent 参数', () => {
    const { spawn } = makeSpawn()
    const tool = createTaskTool(spawn, { agents: [] })
    expect(Object.keys(tool.parameters.properties as object)).toEqual([
      'prompt',
      'description',
      'tools'
    ])
    // 模型曾照着描述填"通用子 Agent",结果解析不到角色 → 宁可不给它这个选项
    expect(tool.parameters.required).toEqual(['prompt', 'description'])
  })

  it('有角色时用 enum 把取值钉死', () => {
    const { spawn } = makeSpawn()
    const tool = createTaskTool(spawn, { agents: ['researcher', 'coder'] })
    const agent = (tool.parameters.properties as Record<string, object>).agent
    expect(agent).toEqual({
      type: 'string',
      enum: ['researcher', 'coder'],
      description: expect.stringContaining('researcher、coder')
    })
  })

  it('名字与步数上限按约定给出', () => {
    expect(TASK_TOOL_NAME).toBe('task')
    expect(SUB_AGENT_MAX_STEPS).toBeLessThan(10)
  })
})

describe('task 工具的执行', () => {
  it('把模型给的参数规整成派生请求', async () => {
    const { requests, spawn } = makeSpawn()
    const tool = createTaskTool(spawn, { agents: ['researcher'] })
    const res = await tool.execute(
      {
        prompt: '  查一下明天的天气  ',
        description: '查天气',
        agent: ' researcher ',
        tools: ['get_current_time', 42]
      },
      context
    )
    expect(await res).toBe('子 Agent 的结论')
    expect(requests).toEqual([
      {
        agent: 'researcher',
        description: '查天气',
        prompt: '查一下明天的天气',
        tools: ['get_current_time', '42']
      }
    ])
  })

  it('省略 agent 与 description 时落到默认值', async () => {
    const { requests, spawn } = makeSpawn()
    const tool = createTaskTool(spawn, { agents: [] })
    await tool.execute({ prompt: '做点什么' }, context)
    expect(requests[0]).toEqual({
      agent: '',
      description: '子任务',
      prompt: '做点什么',
      tools: undefined
    })
  })

  it('tools 不是数组时忽略,不做半吊子解析', async () => {
    const { requests, spawn } = makeSpawn()
    const tool = createTaskTool(spawn, { agents: [] })
    await tool.execute({ prompt: 'p', tools: 'get_current_time' }, context)
    expect(requests[0].tools).toBeUndefined()
  })

  it('缺少 prompt 时抛错,由注册表转成 ok=false', async () => {
    const { requests, spawn } = makeSpawn()
    const runner = createToolRunner([createTaskTool(spawn, { agents: [] })])
    expect(await runner.execute('task', '{"description":"只给了描述"}', context)).toEqual({
      ok: false,
      result: '缺少 prompt'
    })
    expect(requests).toHaveLength(0)
  })

  it('把本次调用的 callId 透传给 spawner', async () => {
    const seen: ToolContext[] = []
    const tool = createTaskTool(
      async (_, ctx) => {
        seen.push(ctx)
        return 'r'
      },
      { agents: [] }
    )
    await tool.execute({ prompt: 'p' }, { callId: 'abc' })
    expect(seen).toEqual([{ callId: 'abc' }])
  })
})

describe('派生上下文的隔离', () => {
  it('子 Agent 的工具池不含 task,派生调用会被当作未知工具拒绝', async () => {
    // service 层为子 Agent 构造 runner 时把父级池里的 task 剔掉了,
    // 于是"子 Agent 再派生孙 Agent"在结构上就不可能发生
    const { spawn } = makeSpawn()
    const parent = createToolRunner([createTaskTool(spawn, { agents: [] })])
    expect(parent.definitions.map((t) => t.name)).toEqual(['task'])

    const child = createToolRunner(parent.definitions.filter((t) => t.name !== TASK_TOOL_NAME))
    expect(child.definitions).toHaveLength(0)
    expect(await child.execute('task', '{"prompt":"p"}', context)).toMatchObject({ ok: false })
  })
})
