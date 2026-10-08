import {
  attachToolResult,
  emptyStep,
  finalizeStep,
  findCall,
  mapCall,
  mapStep,
  type AgentStep,
  type StreamingToolCall
} from '../../../src/renderer/src/lib/agentSteps'

/**
 * 树形 fixture:顶层一步里发起 task 调用,该调用下挂着子 Agent 的一步与其工具。
 * 这正是 useAgentStream 维护的结构,树操作必须在任意深度都成立。
 */
function tree(): AgentStep[] {
  return [
    {
      messageId: 'm1',
      content: '顶层正文',
      reasoning: '',
      toolCalls: [
        {
          id: 'time-1',
          name: 'get_current_time',
          arguments: '{}',
          status: 'success',
          result: '{"iso":"2026-10-08"}'
        },
        {
          id: 'task-1',
          name: 'task',
          arguments: '{"prompt":"查路线"}',
          status: 'running',
          agentName: 'researcher',
          agentSteps: [
            {
              messageId: 'm2',
              content: '',
              reasoning: '子 Agent 的思考',
              toolCalls: [
                {
                  id: 'web-1',
                  name: 'fetch_url',
                  arguments: '{}',
                  status: 'running'
                }
              ]
            }
          ]
        }
      ]
    },
    { messageId: 'm3', content: '收尾正文', reasoning: '', toolCalls: [] }
  ]
}

describe('emptyStep', () => {
  it('新建的步骤没有正文、思考与工具调用', () => {
    expect(emptyStep('m9')).toEqual({ messageId: 'm9', content: '', reasoning: '', toolCalls: [] })
  })
})

describe('findCall', () => {
  it('能命中任意深度的工具调用', () => {
    expect(findCall(tree(), 'time-1')?.name).toBe('get_current_time')
    expect(findCall(tree(), 'web-1')?.name).toBe('fetch_url')
  })

  it('找不到时返回 undefined', () => {
    expect(findCall(tree(), 'nope')).toBeUndefined()
    expect(findCall([], 'time-1')).toBeUndefined()
  })
})

describe('mapCall', () => {
  it('深层替换后其余节点保持引用不变', () => {
    const source = tree()
    const next = mapCall(source, 'web-1', (call): StreamingToolCall => ({
      ...call,
      status: 'success'
    }))
    // 原树不被污染
    expect(findCall(source, 'web-1')?.status).toBe('running')
    // 新树里目标被换掉,兄弟节点原样
    expect(findCall(next, 'web-1')?.status).toBe('success')
    expect(next[0].toolCalls[0]).toBe(source[0].toolCalls[0])
  })

  it('未命中的调用完全按引用透传', () => {
    const source = tree()
    const next = mapCall(source, 'nope', (call) => ({ ...call, result: 'x' }))
    expect(next[0].toolCalls[0]).toBe(source[0].toolCalls[0])
    expect(findCall(next, 'task-1')?.result).toBeUndefined()
  })

  it('命中的父级调用被替换时保留它的子树', () => {
    const next = mapCall(tree(), 'task-1', (call) => ({ ...call, status: 'success' }))
    const parent = findCall(next, 'task-1')
    expect(parent?.status).toBe('success')
    expect(parent?.agentSteps?.[0].toolCalls[0].id).toBe('web-1')
    expect(parent?.agentName).toBe('researcher')
  })
})

describe('mapStep', () => {
  it('按 messageId 命中顶层与深层步骤', () => {
    const appended = mapStep(tree(), 'm3', (step) => ({ ...step, content: step.content + '。' }))
    expect(appended[1].content).toBe('收尾正文。')

    const deep = mapStep(tree(), 'm2', (step) => ({ ...step, content: '子结论' }))
    expect(findCall(deep, 'task-1')?.agentSteps?.[0].content).toBe('子结论')
  })

  it('命中步骤时不再往它的子树里递归', () => {
    const replaced = mapStep(tree(), 'm1', (step) => ({ ...step, content: '改写' }))
    expect(replaced[0].content).toBe('改写')
    expect(replaced[0].toolCalls[1].agentSteps?.[0].reasoning).toBe('子 Agent 的思考')
  })

  it('同一 messageId 在深浅两层各出现一次时只改最外层', () => {
    const ambiguous = mapStep(tree(), 'm1', (step) => ({ ...step, reasoning: 'r' }))
    expect(ambiguous[0].reasoning).toBe('r')
    // 每个 run 的 messageId 由 uuid 生成,重复只可能是构造错误;此处仅固化当前遍历顺序
    expect(findCall(ambiguous, 'task-1')?.agentSteps?.[0].messageId).toBe('m2')
  })
})

describe('attachToolResult', () => {
  it('就地把结果填进对应调用', () => {
    const steps = tree()
    attachToolResult(steps, 'time-1', '{"iso":"new"}')
    expect(steps[0].toolCalls[0].result).toBe('{"iso":"new"}')
    expect(steps[0].toolCalls[0].status).toBe('success')
  })

  it('同 id 出现在多步时从最后一步往前找', () => {
    const repeated: AgentStep[] = [
      {
        messageId: 'a',
        content: '',
        reasoning: '',
        toolCalls: [{ id: 'c', name: 't', arguments: '', status: 'success', result: '旧' }]
      },
      {
        messageId: 'b',
        content: '',
        reasoning: '',
        toolCalls: [{ id: 'c', name: 't', arguments: '', status: 'success', result: '新' }]
      }
    ]
    attachToolResult(repeated, 'c', '覆盖')
    expect(repeated[1].toolCalls[0].result).toBe('覆盖')
    expect(repeated[0].toolCalls[0].result).toBe('旧')
  })

  it('只遍历顶层步骤:子 Agent 的结果不靠它回填', () => {
    // 实时流走 mapCall(可递归),这个函数只服务历史回放,因此深层不命中
    const steps = tree()
    attachToolResult(steps, 'web-1', '不该出现')
    expect(steps[0].toolCalls[1].agentSteps?.[0].toolCalls[0].result).toBeUndefined()
  })

  it('无论成功失败一律标成 success', () => {
    const steps: AgentStep[] = [
      {
        messageId: 'a',
        content: '',
        reasoning: '',
        toolCalls: [{ id: 'c', name: 't', arguments: '', status: 'running' }]
      }
    ]
    attachToolResult(steps, 'c', '工具报错说明')
    expect(steps[0].toolCalls[0].status).toBe('success')
  })
})

describe('finalizeStep', () => {
  it('把仍是 running 的调用标成中止,并递归到子 Agent', () => {
    const finalized = finalizeStep(tree()[0])
    expect(finalized.toolCalls[1].status).toBe('error')
    expect(finalized.toolCalls[1].result).toBe('已中止')
    expect(finalized.toolCalls[1].agentSteps?.[0].toolCalls[0].status).toBe('error')
    expect(finalized.toolCalls[1].agentSteps?.[0].toolCalls[0].result).toBe('已中止')
  })

  it('已完成的调用与它的结果保持原样', () => {
    const finalized = finalizeStep(tree()[0])
    expect(finalized.toolCalls[0].status).toBe('success')
    expect(finalized.toolCalls[0].result).toBe('{"iso":"2026-10-08"}')
  })

  it('不修改传入的步骤', () => {
    const source = tree()
    finalizeStep(source[0])
    expect(source[0].toolCalls[1].status).toBe('running')
    expect(source[0].toolCalls[1].agentSteps?.[0].toolCalls[0].status).toBe('running')
  })

  it('error 状态的结果文本不被覆盖', () => {
    const step: AgentStep = {
      messageId: 'a',
      content: '',
      reasoning: '',
      toolCalls: [{ id: 'c', name: 't', arguments: '', status: 'error', result: '参数不合法' }]
    }
    expect(finalizeStep(step).toolCalls[0].result).toBe('参数不合法')
  })
})
