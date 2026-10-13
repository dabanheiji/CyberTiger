import type {
  ChatCompletionMessage,
  StreamChatParams,
  StreamChatResult
} from '../../../src/main/chat/llm'
import type { IdentifiedMessage } from '../../../src/main/agent/turns'
import {
  DEFAULT_COMPACT_POLICY,
  chunkLimit,
  compactConversation,
  earlierDigest,
  lastCoveredId,
  planCompaction,
  splitChunks,
  summaryInstructions,
  summaryRequest,
  taskStateNote,
  toCompactUnits,
  type CompactPlan,
  type CompactPolicy,
  type CompactSizing,
  type CompactUnit
} from '../../../src/main/agent/compact'
import { makeModel, type ModelStep } from '../../helpers/agent'

/**
 * planCompaction / splitChunks 只读单元的 tokens、messages.length 与 lastId,
 * 所以边界类用例手搓单元,断言能算得准;
 * 「分组规则本身」的用例才需要真实消息(见 toCompactUnits 那组)。
 */
function unit(id: string, tokens: number, messages = 1): CompactUnit {
  return {
    messages: Array.from({ length: messages }, (_, i) => ({
      role: 'user',
      content: messages > 1 ? `${id}${i}` : id
    })),
    tokens,
    lastId: id
  }
}

function units(count: number, tokens: number): CompactUnit[] {
  return Array.from({ length: count }, (_, i) => unit(`a${i}`, tokens))
}

function msg(
  role: 'user' | 'assistant' | 'tool',
  marker: string,
  tokens: number
): ChatCompletionMessage {
  if (role === 'tool') {
    return { role: 'tool', tool_call_id: marker, content: '中'.repeat(tokens) }
  }
  return { role, content: marker + '中'.repeat(Math.max(0, tokens - 1)) }
}

/** 带库内 id 的消息:id 直接用标记,水位断言能读到它 */
function item(role: 'user' | 'assistant' | 'tool', marker: string, tokens = 10): IdentifiedMessage {
  return { id: marker, message: msg(role, marker, tokens) }
}

/** 一次调用连同它的工具结果:按 agent/turns.ts 的规则必然同属一个单元 */
function callItems(id: string, toolId: string, tokens: number): IdentifiedMessage[] {
  return [
    {
      id,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: toolId, type: 'function', function: { name: 'p', arguments: '{}' } }]
      }
    },
    item('tool', toolId, tokens)
  ]
}

function rolesOf(unit: CompactUnit): string[] {
  return unit.messages.map((m) => m.role)
}

/** 一段消息里 assistant 发起的调用是否都在同一段内得到响应 */
function expectNoOrphanCalls(messages: ChatCompletionMessage[]): void {
  const answered = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id))
  const orphans = messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.tool_calls ?? [])
    .filter((call) => !answered.has(call.id))
  expect(orphans.map((call) => call.id)).toEqual([])
}

function sizing(window = 12_000, overrides: Partial<CompactSizing> = {}): CompactSizing {
  return { fixedTokens: 1_000, summaryTokens: 0, window, ...overrides }
}

/** 取压缩计划;用例默认 force,把注意力留给边界而不是触发线 */
function planOf(
  source: CompactUnit[],
  size: CompactSizing = sizing(),
  policy: CompactPolicy = DEFAULT_COMPACT_POLICY
): CompactPlan {
  const decision = planCompaction(source, size, policy, true)
  if (!decision.should) throw new Error(`测试数据本该可压缩,却被拒: ${decision.reason}`)
  return decision.plan
}

/**
 * 窗口 4000:后缀额度算出 0、每段只装得下一个单元,7 个待摘要单元必然切成多段。
 * 段数正好落在 maxChunks 以内,所以这份计划没有 dropped。
 */
function multiChunkPlan(): CompactPlan {
  return planOf(units(5, 500), sizing(4_000))
}

/** 每段一个成功脚本步 */
function scriptFor(plan: CompactPlan, text: (index: number) => string): ModelStep[] {
  return plan.chunks.map((_, index) => ({ content: text(index) }))
}

async function compact(
  plan: CompactPlan,
  script: ModelStep[],
  options: {
    previousSummary?: string
    stateNote?: string
    policy?: CompactPolicy
    aborted?: boolean
    stream?: (params: StreamChatParams) => Promise<StreamChatResult>
  } = {}
): Promise<{
  outcome: Awaited<ReturnType<typeof compactConversation>>
  requests: StreamChatParams[]
}> {
  const model = makeModel(script)
  const controller = new AbortController()
  if (options.aborted) controller.abort()
  const outcome = await compactConversation({
    baseUrl: 'https://model.test/v1',
    model: 'test-model',
    signal: controller.signal,
    previousSummary: options.previousSummary ?? '',
    plan,
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.stateNote ? { stateNote: options.stateNote } : {}),
    stream: options.stream ?? model.stream
  })
  return { outcome, requests: model.requests }
}

describe('toCompactUnits 的分组边界', () => {
  it('user 与 assistant 各自起一个单元,tool 行并进发起它的那个单元', () => {
    const units = toCompactUnits([
      item('user', '问'),
      ...callItems('甲', 'c1', 100),
      item('assistant', '乙'),
      item('user', '再问')
    ])
    expect(units.map(rolesOf)).toEqual([['user'], ['assistant', 'tool'], ['assistant'], ['user']])
  })

  it('单元的 lastId 是它最后一条消息的 id:水位靠它推进', () => {
    expect(toCompactUnits(callItems('a1', 'c1', 100))[0].lastId).toBe('c1')
  })

  it('单元 token 是内部消息 token 之和', () => {
    // assistant 调用:4 + 8 + 名字 1 + 参数 1 = 14;tool 结果:4 + 100
    expect(toCompactUnits(callItems('a1', 'c1', 100))[0].tokens).toBe(118)
  })
})

describe('planCompaction 选边界', () => {
  it('没过触发线时不动手;手动压缩越过这一条,但收益不足照样拒', () => {
    const source = units(12, 400)
    // 已用 5800,窗口 100k 远未过 80%
    expect(planCompaction(source, sizing(100_000))).toEqual({
      should: false,
      reason: 'below-trigger'
    })
    // force 只越过触发线这一条:窗口 8000 下压完从 5800 降到 2600
    expect(planCompaction(source, sizing(8_000), DEFAULT_COMPACT_POLICY, true).should).toBe(true)
    // 摘要上限 5000 就把额度吃光了:force 也不该压
    const greedy: CompactPolicy = { ...DEFAULT_COMPACT_POLICY, summaryMaxTokens: 5_000 }
    expect(planCompaction(source, sizing(6_000), greedy, true)).toEqual({
      should: false,
      reason: 'poor-saving'
    })
  })

  it('保留最长后缀:从最新往回收到额度用尽', () => {
    // 目标 35%×12000 = 4200,减固定 1000 与摘要上限 1200 → 后缀额度 2000 = 5 个单元
    const plan = planOf(units(12, 400))
    expect(plan.kept.map((u) => u.lastId)).toEqual(['a7', 'a8', 'a9', 'a10', 'a11'])
    expect(plan.covered.map((u) => u.lastId)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6'])
    expect(plan.projectedTokens).toBe(4_200)
    expect(plan.savedTokens).toBe(5_800 - 4_200)
  })

  it('最新单元无条件保留,哪怕它自己就超过后缀额度', () => {
    // 后缀额度 2000,而最新单元 5000:它必须留在原文里,摘要救不了刚问的事
    const plan = planOf([...units(8, 900), unit('巨大', 5_000, 3)])
    expect(plan.kept.map((u) => u.lastId)).toEqual(['巨大'])
    expect(plan.covered).toHaveLength(8)
  })

  it('可压的单元少于 minUnits 时拒绝:省不出多少还多烧一次调用', () => {
    // 固定开销 3400 → 后缀额度 0,只留最新一个单元,剩下 5 个可压
    const plan = planOf(units(6, 500), sizing(12_000, { fixedTokens: 3_400 }))
    expect(plan.covered).toHaveLength(5)
    expect(
      planCompaction(
        units(3, 400),
        sizing(12_000),
        { ...DEFAULT_COMPACT_POLICY, minUnits: 4 },
        true
      )
    ).toEqual({ should: false, reason: 'too-few-units' })
  })

  it('账目按覆盖段给出:条数与 token 都对得上', () => {
    const plan = planOf(Array.from({ length: 12 }, (_, i) => unit(`a${i}`, 400, 2)))
    expect(plan.coveredMessages).toBe(14)
    expect(plan.coveredTokens).toBe(7 * 400)
  })

  it('分段边界只落在单元上:任何一段都不出现「有调用无响应」', () => {
    const source = toCompactUnits([
      item('user', '问', 300),
      ...callItems('a0', 'c0', 1_500),
      ...callItems('a1', 'c1', 1_500),
      ...callItems('a2', 'c2', 1_500),
      item('assistant', '收尾', 300)
    ])
    const plan = planOf(source, sizing(8_000, { fixedTokens: 400 }))
    expect(plan.chunks.length).toBeGreaterThan(1)
    for (const chunk of plan.chunks) expectNoOrphanCalls(chunk.flatMap((u) => u.messages))
    expectNoOrphanCalls(plan.kept.flatMap((u) => u.messages))
  })

  it('旧摘要不占后缀额度:新摘要**替换**它,而不是在旧摘要上再加一份', () => {
    // 后缀额度只看 targetRatio×窗口 − 固定开销 − 摘要上限,与 summaryTokens 无关
    expect(planOf(units(12, 400)).kept).toHaveLength(5)
    expect(planOf(units(12, 400), sizing(12_000, { summaryTokens: 1_200 })).kept).toHaveLength(5)
  })

  it('旧摘要照样计入「已用」:第二次压缩更容易触发,省掉的也包含它', () => {
    const source = units(12, 400)
    // 无旧摘要:已用 5800 < 0.8×8000;带上 1200 的旧摘要:7000 越线
    expect(planCompaction(source, sizing(8_000))).toEqual({
      should: false,
      reason: 'below-trigger'
    })
    const plan = planOf(source, sizing(8_000, { summaryTokens: 1_200 }))
    expect(plan.projectedTokens).toBe(2_600)
    // 已用里含旧摘要(7000),所以省掉的额度也把旧摘要算进去了
    expect(plan.savedTokens).toBe(7_000 - 2_600)
  })
})

describe('splitChunks 的分段上限', () => {
  it('按额度从最旧开始贪心分,单元不拆开', () => {
    const result = splitChunks(units(4, 200), 400, 10)
    expect(result.chunks.map((chunk) => chunk.map((u) => u.lastId))).toEqual([
      ['a0', 'a1'],
      ['a2', 'a3']
    ])
    expect(result.dropped).toEqual([])
  })

  it('自己就超上限的单元独占一段:单元不能再切', () => {
    const result = splitChunks([unit('巨大', 5_000), unit('b', 100), unit('c', 100)], 400, 10)
    expect(result.chunks.map((chunk) => chunk.length)).toEqual([1, 2])
  })

  it('段数超上限时把最旧的挤掉并登记为 dropped,不静默丢', () => {
    const result = splitChunks(units(6, 200), 400, 2)
    expect(result.chunks).toHaveLength(2)
    expect(result.chunks[1].map((u) => u.lastId)).toEqual(['a4', 'a5'])
    expect(result.chunks[0].map((u) => u.lastId)).toEqual(['a2', 'a3'])
    expect(result.dropped.map((u) => u.lastId)).toEqual(['a0', 'a1'])
  })

  it('chunkLimit 至少留出可读的正文空间,窗口再小也不给 0', () => {
    expect(chunkLimit(sizing(1_000))).toBeGreaterThanOrEqual(600)
    expect(chunkLimit(sizing(200_000))).toBeGreaterThan(chunkLimit(sizing(20_000)))
  })
})

describe('earlierDigest:摘要都没进过的更早内容', () => {
  it('抽出 URL、路径与代码标识,并写明细节可能缺失', () => {
    const digest = earlierDigest([
      {
        messages: [
          { role: 'user', content: '帮我看下 src/main/agent/loop.ts,参考 https://example.com/a/b' },
          { role: 'assistant', content: '读了 `planContext()`,细节在 src/main/agent/context.ts' }
        ],
        tokens: 100,
        lastId: 'x1'
      }
    ])
    expect(digest).toContain('https://example.com/a/b')
    expect(digest).toContain('src/main/agent/loop.ts')
    expect(digest).toContain('`planContext()`')
    expect(digest).toContain('没有原文送给模型')
  })

  it('没有溢出段时给空串,请求里不会出现这一节', () => {
    expect(earlierDigest([])).toBe('')
  })

  it('标识数量有上限,长对话不会撑爆摘要请求', () => {
    const long = Array.from({ length: 200 }, (_, i) => `https://site.test/${i}/p`).join(' ')
    const digest = earlierDigest([
      { messages: [{ role: 'assistant', content: long }], tokens: 1_000, lastId: 'x' }
    ])
    expect(digest.split('\n- ').filter((line) => line.startsWith('https'))).toHaveLength(60)
    expect(digest).toContain('标识清单到此为止')
  })
})

describe('summaryRequest 组装摘要请求', () => {
  it('顺序是 指令 → 已知前情 → 本段原文 → 执行状态便签', () => {
    const messages = summaryRequest({
      instructions: '指令',
      previous: '旧摘要',
      chunk: [msg('user', '问', 5), msg('assistant', '答', 5)],
      note: '本轮目标:查时间'
    })
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'user', 'assistant', 'user'])
    expect(messages[1].content).toContain('## 已知前情(可能为空)\n旧摘要')
    expect(messages[1].content).toContain('## 本段对话')
    expect(messages[4].content).toContain('## 本轮执行状态')
  })

  it('没有旧摘要时写「(无)」,不让模型以为前情丢了', () => {
    const [system, head] = summaryRequest({ instructions: '指令', previous: '', chunk: [] })
    expect(system.content).toBe('指令')
    expect(head.content).toContain('## 已知前情(可能为空)\n(无)')
  })

  it('溢出清单排在已知前情之后、本段对话之前', () => {
    const [, head] = summaryRequest({
      instructions: '指令',
      previous: '旧摘要',
      earlier: '更早的标识清单',
      chunk: []
    })
    const text = String(head.content)
    expect(text.indexOf('## 已知前情')).toBeLessThan(text.indexOf('## 更早的历史'))
    expect(text.indexOf('## 更早的历史')).toBeLessThan(text.indexOf('## 本段对话'))
  })
})

describe('summaryInstructions', () => {
  it('把长度上限写进指令,而不是只靠事后截断', () => {
    expect(summaryInstructions({ ...DEFAULT_COMPACT_POLICY, summaryMaxTokens: 900 })).toContain(
      '不超过 900 token'
    )
  })

  it('小节骨架固定,进行中与待办不能省:任务要能跨压缩续跑', () => {
    for (const section of ['会话目标', '关键事实与约束', '已完成', '进行中', '待办与未解决问题']) {
      expect(summaryInstructions()).toContain(section)
    }
  })

  it('工具调用只记结论,不写「请重新调用」这类祈使', () => {
    expect(summaryInstructions()).not.toMatch(/请重新|必须重新|如需.*调用/)
  })
})

describe('compactConversation 的滚动分段', () => {
  it('每段一次调用,后一段带着前一段的结论继续', async () => {
    const plan = multiChunkPlan()
    expect(plan.chunks.length).toBeGreaterThan(1)
    const { outcome, requests } = await compact(
      plan,
      scriptFor(plan, (i) => `第${i + 1}段摘要`)
    )
    expect(requests).toHaveLength(plan.chunks.length)
    // 滚动携带:下一次请求的「已知前情」是上一次的结果 —— 替换语义不丢前情
    expect(String(requests[1].messages[1].content)).toContain('第1段摘要')
    expect(outcome.ok).toBe(true)
    expect(outcome.summary).toBe(`第${plan.chunks.length}段摘要`)
  })

  it('水位落在最后一段的最后一条消息上', async () => {
    const plan = planOf(units(12, 400))
    const { outcome } = await compact(plan, [{ content: '摘要' }])
    expect(outcome.untilMessageId).toBe(lastCoveredId(plan))
    expect(outcome.untilMessageId).toBe('a6')
  })

  it('带旧摘要时它作为已知前情进入第一次请求', async () => {
    const { requests } = await compact(planOf(units(12, 400)), [{ content: '新摘要' }], {
      previousSummary: '第一次压缩的摘要'
    })
    expect(requests[0].messages[1].content).toContain('第一次压缩的摘要')
  })

  it('执行状态便签只随最后一段送出,且落在待摘要内容之后', async () => {
    const plan = multiChunkPlan()
    const { requests } = await compact(
      plan,
      scriptFor(plan, () => '摘要'),
      {
        stateNote: '本轮目标:查路线'
      }
    )
    const last = requests[requests.length - 1].messages
    expect(String(last[last.length - 1].content)).toContain('本轮目标:查路线')
    expect(JSON.stringify(requests[0].messages)).not.toContain('本轮目标')
  })

  it('溢出段的标识清单既进第一次请求,也接在摘要末尾:水位越过它也不静默消失', async () => {
    const plan = planOf(units(20, 500), sizing(4_000))
    expect(plan.dropped.length).toBeGreaterThan(0)
    const { outcome, requests } = await compact(
      plan,
      scriptFor(plan, (i) => `摘要${i}`)
    )
    expect(JSON.stringify(requests[0].messages)).toContain(plan.dropped[0].lastId)
    expect(outcome.summary).toContain('更早的历史')
    expect(outcome.summary).toContain(plan.dropped[0].lastId)
  })

  it('摘要超过长度上限时硬切并标注省略', async () => {
    const long = '长'.repeat(4_000)
    const { outcome } = await compact(planOf(units(12, 400)), [{ content: long }])
    expect(outcome.summary).toContain('[摘要超出长度上限,此后内容省略]')
    expect(outcome.summary.length).toBeLessThan(long.length)
  })
})

describe('compactConversation 的失败与中止', () => {
  it('模型报错时整次压缩失败,不给水位', async () => {
    const { outcome } = await compact(planOf(units(12, 400)), [], {
      stream: async () => {
        throw new Error('连接被拒绝')
      }
    })
    expect(outcome).toMatchObject({
      ok: false,
      summary: '',
      untilMessageId: '',
      msg: '连接被拒绝',
      aborted: false
    })
  })

  it('多段时后一段失败也算整次失败:不用半截摘要冒充完整摘要', async () => {
    const plan = multiChunkPlan()
    expect(plan.chunks.length).toBeGreaterThan(1)
    let calls = 0
    const { outcome } = await compact(plan, [], {
      stream: async (params) => {
        calls++
        if (calls === 1) {
          params.onDelta({ content: '第一段摘要', reasoning: '' })
          return { toolCalls: [] }
        }
        throw new Error('第二段失败')
      }
    })
    expect(outcome).toMatchObject({
      ok: false,
      summary: '',
      untilMessageId: '',
      msg: '第二段失败'
    })
  })

  it('信号已中止时不调用模型,不写水位', async () => {
    const { outcome, requests } = await compact(planOf(units(12, 400)), [{ content: '摘要' }], {
      aborted: true
    })
    expect(outcome).toMatchObject({ ok: false, summary: '', untilMessageId: '', aborted: true })
    expect(requests).toHaveLength(0)
  })

  it('模型返回空正文视为失败', async () => {
    const { outcome } = await compact(planOf(units(12, 400)), [{ content: '   ' }])
    expect(outcome).toMatchObject({ ok: false, summary: '', untilMessageId: '' })
  })
})

describe('compactConversation 的用量与账目', () => {
  it('端点报了 usage 就逐段累加并标为真实值', async () => {
    const plan = multiChunkPlan()
    const { outcome } = await compact(
      plan,
      plan.chunks.map(() => ({ content: '摘要', usage: { prompt: 500, completion: 40 } }))
    )
    expect(outcome.usage).toEqual({
      prompt: 500 * plan.chunks.length,
      completion: 40 * plan.chunks.length,
      estimated: false
    })
    expect(outcome.metrics).toMatchObject({
      prompt: outcome.usage.prompt,
      coveredMessages: plan.coveredMessages,
      coveredTokens: plan.coveredTokens
    })
    expect(outcome.metrics?.at).toBeTruthy()
  })

  it('端点不报 usage 时退回估算并标 estimated', async () => {
    const { outcome } = await compact(planOf(units(12, 400)), [{ content: '摘' }])
    expect(outcome.usage.estimated).toBe(true)
    expect(outcome.usage.prompt).toBeGreaterThan(0)
  })
})

describe('taskStateNote:压缩后续跑靠它', () => {
  const base = {
    request: '查中牟到汝阳的路线',
    step: 3,
    maxSteps: 10,
    lastAssistant: '已经拿到高速段的距离,还差县道'
  }

  it('写明进度、剩余步数与已执行工具的结论', () => {
    const note = taskStateNote({
      ...base,
      executed: [
        { name: 'get_route', arguments: '{"from":"中牟"}', ok: true, result: '约 120 公里' }
      ]
    })
    expect(note).toContain('第 3 步,最多 10 步,剩余 7 步')
    expect(note).toContain('get_route({"from":"中牟"}) → 成功:约 120 公里')
  })

  it('没执行过工具时写「(无)」,不留空小节让模型猜', () => {
    expect(taskStateNote({ ...base, executed: [] })).toContain('- 已执行的工具:(无)')
  })

  it('工具结论过长时截断:便签不能把摘要请求撑爆', () => {
    const note = taskStateNote({
      ...base,
      executed: [{ name: 'read_file', arguments: '{}', ok: true, result: '长'.repeat(2_000) }]
    })
    expect(note).not.toContain('长'.repeat(200))
    expect(note.length).toBeLessThan(1_000)
  })

  it('只陈述已完成与待判断的动作,不写「请重新调用」', () => {
    const note = taskStateNote({
      ...base,
      executed: [{ name: 'get_current_time', arguments: '{}', ok: false, result: '超时' }]
    })
    expect(note).toContain('get_current_time({}) → 失败:超时')
    expect(note).not.toMatch(/请重新|必须重新调用|每次都要/)
  })
})
