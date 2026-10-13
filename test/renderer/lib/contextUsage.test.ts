import { emptyStep } from '../../../src/renderer/src/lib/agentSteps'
import {
  compactReasonText,
  compactResultLine,
  contextShare,
  contextUsage,
  latestInputOfMessages,
  latestInputOfSteps,
  usageLevel
} from '../../../src/renderer/src/lib/contextUsage'
import { makeMessage } from '../../helpers/fixtures'
import type { AgentStep } from '../../../src/renderer/src/lib/agentSteps'
import type { CompactReport } from '../../../src/main/chat/dto'
import type { ModelConfig, ModelProvider } from '../../../src/main/store/types'

function provider(models: ModelConfig[], id = 'p-1'): ModelProvider {
  return { id, name: id, baseUrl: 'http://x.test/v1', models }
}

function step(prompt?: number, estimated = false): AgentStep {
  const s = emptyStep('s-1')
  if (prompt !== undefined) s.usage = { prompt, completion: 10, estimated }
  return s
}

const REF = { providerId: 'p-1', model: 'm' }

describe('latestInputOfSteps', () => {
  it('取各步里最大的输入占用而不是求和 —— 后一步的输入包含前一步的全部历史', () => {
    expect(latestInputOfSteps([step(1000), step(4200), step(2600)])).toEqual({
      used: 4200,
      estimated: false
    })
  })

  it('忽略还没有用量的步骤(第一步还在流式途中)', () => {
    expect(latestInputOfSteps([step(), step(800)])).toEqual({ used: 800, estimated: false })
  })

  it('整组都没用量时返回 null,让调用方退回库里的行', () => {
    expect(latestInputOfSteps([step(), step()])).toBeNull()
    expect(latestInputOfSteps([])).toBeNull()
  })

  it('估算标记跟着那条最大的步骤走', () => {
    expect(latestInputOfSteps([step(1000), step(4200, true)])?.estimated).toBe(true)
  })
})

describe('latestInputOfMessages', () => {
  it('从后往前取第一条有量化的顶层 assistant 行', () => {
    const hit = latestInputOfMessages([
      makeMessage({ role: 'assistant', prompt_tokens: 900 }),
      makeMessage({ role: 'user' }),
      makeMessage({ role: 'assistant', prompt_tokens: 3100, tokens_estimated: 1 })
    ])
    expect(hit).toEqual({ used: 3100, estimated: true })
  })

  it('跳过子 Agent 的行:那是另一份上下文,不能并进主会话的窗口', () => {
    const hit = latestInputOfMessages([
      makeMessage({ role: 'assistant', prompt_tokens: 2000 }),
      makeMessage({ role: 'assistant', prompt_tokens: 9999, parent_call_id: 'call-1', depth: 1 })
    ])
    expect(hit?.used).toBe(2000)
  })

  it('老数据从没写过用量时返回 null,界面就不显示比例', () => {
    expect(latestInputOfMessages([makeMessage({ role: 'assistant' })])).toBeNull()
  })
})

describe('contextUsage', () => {
  it('按所选模型配置的窗口算出比例', () => {
    const usage = contextUsage({
      messages: [makeMessage({ role: 'assistant', prompt_tokens: 20_000 })],
      providers: [provider([{ name: 'm', contextWindow: 100_000 }])],
      currentRef: REF
    })
    expect(usage).toEqual({
      used: 20_000,
      estimated: false,
      window: 100_000,
      trimAt: 81_000,
      ratio: 0.2
    })
  })

  it('模型没配窗口时退回默认值,与主进程的兜底同一套规则', () => {
    const usage = contextUsage({
      messages: [makeMessage({ role: 'assistant', prompt_tokens: 1000 })],
      providers: [provider([{ name: 'm' }])],
      currentRef: REF
    })
    expect(usage?.window).toBe(131_072)
  })

  it('流式中的步骤优先于库里的行', () => {
    const usage = contextUsage({
      streamingSteps: [step(50_000)],
      messages: [makeMessage({ role: 'assistant', prompt_tokens: 20_000 })],
      providers: [provider([{ name: 'm', contextWindow: 100_000 }])],
      currentRef: REF
    })
    expect(usage?.used).toBe(50_000)
  })

  it('流式刚开始还没有用量时退回上一条落库的用量', () => {
    const usage = contextUsage({
      streamingSteps: [step()],
      messages: [makeMessage({ role: 'assistant', prompt_tokens: 12_000 })],
      providers: [provider([{ name: 'm', contextWindow: 100_000 }])],
      currentRef: REF
    })
    expect(usage?.used).toBe(12_000)
  })

  it('超出窗口时比例夹在 1 —— 估算误差或窗口配小了都不该显示 137%', () => {
    const usage = contextUsage({
      messages: [makeMessage({ role: 'assistant', prompt_tokens: 250_000 })],
      providers: [provider([{ name: 'm', contextWindow: 100_000 }])],
      currentRef: REF
    })
    expect(usage?.ratio).toBe(1)
  })

  it('新会话没有任何用量时返回 null,而不是一条 0% 的空条', () => {
    const base = {
      messages: [makeMessage({ role: 'user' })],
      providers: [provider([{ name: 'm', contextWindow: 100_000 }])],
      currentRef: REF
    }
    expect(contextUsage(base)).toBeNull()
    // 没选模型同样不算:分母根本无从取得
    expect(
      contextUsage({
        ...base,
        messages: [makeMessage({ role: 'assistant', prompt_tokens: 1000 })],
        currentRef: undefined
      })
    ).toBeNull()
  })
})

describe('usageLevel', () => {
  const withUsed = (used: number, window = 100_000) => ({
    used,
    estimated: false,
    window,
    trimAt: 81_000,
    ratio: used / window
  })

  it('离预算还远时是常态色', () => {
    expect(usageLevel(withUsed(10_000))).toBe('normal')
  })

  it('占用到七成先转黄', () => {
    expect(usageLevel(withUsed(70_000))).toBe('warning')
  })

  it('超过裁剪点转红:此时丢历史已经在发生了', () => {
    expect(usageLevel(withUsed(82_000))).toBe('danger')
  })
})

describe('contextShare', () => {
  it('拼出气泡底部的「/窗口(百分比)」', () => {
    expect(contextShare(20_000, 100_000)).toBe('/100k(20%)')
  })

  it('没有窗口时返回空串,而不是编一个默认分母', () => {
    expect(contextShare(20_000)).toBe('')
    expect(contextShare(20_000, 0)).toBe('')
  })
})

describe('压缩结论的一行说明', () => {
  const report = (overrides: Partial<CompactReport>): CompactReport => ({
    compacted: true,
    window: 100_000,
    ...overrides
  })

  it('压成了就报「省下多少 + 压完约多少」', () => {
    expect(
      compactResultLine(
        report({
          usage: { prompt: 5000, completion: 300, estimated: false },
          metrics: {
            prompt: 5000,
            completion: 300,
            estimated: false,
            coveredMessages: 12,
            coveredTokens: 30_000,
            at: '2026-10-12T09:00:00Z'
          },
          projectedTokens: 40_000
        })
      )
    ).toBe('已压进摘要、省下 30k,压完约 40k')
  })

  it('三种拒绝原因各有一句解释,界面不用猜', () => {
    for (const reason of ['below-trigger', 'too-few-units', 'poor-saving'] as const) {
      expect(compactReasonText(reason)).not.toBe('')
      expect(compactReasonText(reason)).toContain('压')
    }
  })

  it('被计划拒绝时说清原因,而不是回一句「没压」', () => {
    expect(compactResultLine(report({ compacted: false, reason: 'too-few-units' }))).toContain(
      '不足 3 组'
    )
    // 摘要调用失败带的是面向用户的中文提示
    expect(compactResultLine(report({ compacted: false, msg: '连接被拒绝' }))).toBe(
      '压缩失败:连接被拒绝'
    )
  })
})
