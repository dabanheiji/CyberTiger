import type { PendingApprovalDto } from '../../../src/main/chat/dto'
import { createApprovalGate } from '../../../src/main/chat/approvals'

function request(approvalId: string): PendingApprovalDto {
  return {
    approvalId,
    conversationId: 'c1',
    callId: `call-${approvalId}`,
    tool: 'run_command',
    summary: '执行命令:rm -rf build',
    detail: ['工作目录:/ws'],
    risk: 'elevated',
    runAllowKey: 'rm -rf [cwd=/ws]',
    agent: ''
  }
}

describe('审批通道的等待', () => {
  it('决定到手才 resolve,并把用户按下的那颗按钮原样交回', async () => {
    const gate = createApprovalGate()
    const wait = gate.open(request('a1'), new AbortController().signal)
    expect(gate.list()).toHaveLength(1)

    expect(gate.decide('a1', 'allow')).toBe(true)
    expect(await wait).toEqual({ kind: 'allow' })
  })

  it('拒绝带着用户补的原因原样回来:那是模型唯一能看到「为什么被拒」的入口', async () => {
    const gate = createApprovalGate()
    const wait = gate.open(request('a1'), new AbortController().signal)
    gate.decide('a1', 'deny', '这个目录我在改东西')
    expect(await wait).toEqual({ kind: 'deny', reason: '这个目录我在改东西' })
  })

  it('拒绝不给原因是合法的:原因本来就是可选项,不报错也不空白', async () => {
    const gate = createApprovalGate()
    const wait = gate.open(request('a1'), new AbortController().signal)
    gate.decide('a1', 'deny')
    expect(await wait).toEqual({ kind: 'deny', reason: '' })
  })

  it('中止按「没有批准」收场,绝不让等待永远悬着', async () => {
    // 否则整个 run 的收尾、以及它占着的那个会话(切工作空间与手动压缩都要求无进行中 run)一起卡死
    const gate = createApprovalGate()
    const controller = new AbortController()
    const wait = gate.open(request('a1'), controller.signal)
    controller.abort()
    expect(await wait).toEqual({ kind: 'aborted' })
    expect(gate.list()).toHaveLength(0)
  })

  it('中止先于登记发生时直接按没批准收场,也不登记等待', async () => {
    const controller = new AbortController()
    controller.abort()
    const gate = createApprovalGate()
    expect(await gate.open(request('a1'), controller.signal)).toEqual({ kind: 'aborted' })
    expect(gate.list()).toHaveLength(0)
  })

  it('无人应答按时收了结:窗口关了或渲染层崩了都不能把整轮吊住', async () => {
    const gate = createApprovalGate(5)
    const wait = gate.open(request('a1'), new AbortController().signal)
    expect(await wait).toEqual({ kind: 'timeout' })
    expect(gate.list()).toHaveLength(0)
  })

  it('超时后再中止不再改写结果:同一条等待只了结一次', async () => {
    const gate = createApprovalGate(5)
    const controller = new AbortController()
    const wait = gate.open(request('a1'), controller.signal)
    await wait
    controller.abort()
    expect(await wait).toEqual({ kind: 'timeout' })
  })

  it('决定到手后中止不再改写结果:用户真的批了,不该被写成没批准', async () => {
    const gate = createApprovalGate()
    const controller = new AbortController()
    const wait = gate.open(request('a1'), controller.signal)
    gate.decide('a1', 'allow')
    controller.abort()
    expect(await wait).toEqual({ kind: 'allow' })
  })
})

describe('审批通道的认领', () => {
  it('不认识的 id 返回 false:界面据此知道这条决定没处送', () => {
    const gate = createApprovalGate()
    expect(gate.decide('never-asked', 'allow')).toBe(false)
  })

  it('同一个请求只接受第一次决定:连点两次提交不给模型两个矛盾的答案', async () => {
    const gate = createApprovalGate()
    const wait = gate.open(request('a1'), new AbortController().signal)
    expect(gate.decide('a1', 'allow')).toBe(true)
    expect(gate.decide('a1', 'deny', '改主意')).toBe(false)
    expect(await wait).toEqual({ kind: 'allow' })
  })

  it('两个请求可以同时在等,决定按 id 各自认领', async () => {
    const gate = createApprovalGate()
    const first = gate.open(request('a1'), new AbortController().signal)
    const second = gate.open(request('a2'), new AbortController().signal)
    expect(gate.list().map((item) => item.approvalId)).toEqual(['a1', 'a2'])
    gate.decide('a2', 'allow_run')
    expect(await second).toEqual({ kind: 'allow_run' })
    // 第二个了结不能顺手把第一个也摘掉:a2 的决定不代表 a1 批了
    expect(gate.list()).toHaveLength(1)
    gate.decide('a1', 'allow')
    expect(await first).toEqual({ kind: 'allow' })
  })

  it('一次了结不影响另一条的中止:摘除时不能把别人的监听解掉', async () => {
    const gate = createApprovalGate()
    const a = new AbortController()
    const b = new AbortController()
    const waitA = gate.open(request('a1'), a.signal)
    const waitB = gate.open(request('a2'), b.signal)
    b.abort()
    expect(await waitB).toEqual({ kind: 'aborted' })
    gate.decide('a1', 'allow')
    expect(await waitA).toEqual({ kind: 'allow' })
  })

  it('全部了结后等待清零,会话不会被留在「有进行中的 run」状态', async () => {
    const gate = createApprovalGate()
    const controller = new AbortController()
    const waitA = gate.open(request('a1'), controller.signal)
    const waitB = gate.open(request('a2'), new AbortController().signal)
    controller.abort()
    gate.decide('a2', 'deny')
    await Promise.all([waitA, waitB])
    expect(gate.list()).toHaveLength(0)
  })
})

describe('待审批清单', () => {
  it('列出的是完整的展示载荷:渲染层重载后只凭它就重画得出卡片', async () => {
    const gate = createApprovalGate()
    const wait = gate.open(request('a1'), new AbortController().signal)
    expect(gate.list()[0]).toEqual(request('a1'))
    gate.decide('a1', 'allow')
    await wait
  })
})
