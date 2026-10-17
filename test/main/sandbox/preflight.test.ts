import { engineFor, interpretProbe, type ProbeOutcome } from '../../../src/main/sandbox/preflight'

/**
 * 引擎预检的结论层。
 *
 * 探针本身是 spawn,不在单测里跑(那会让每一次 `npm test` 都起真进程);这一层断的是
 * 「原始事实 → 面向用户的一句话」的映射。判错的代价很具体:界面说「可用」而命令实际起不来,
 * 或者把「这台机器没有这种机制」写成「机制坏了」,用户照着去装一个用不上的东西。
 */

const ok: ProbeOutcome = { code: 0, stderr: '' }

describe('平台到引擎', () => {
  it('mac 是 sandbox-exec、Linux 是 bubblewrap、其余没有对应机制:分支写错就会在不存在的引擎上探针', () => {
    expect(engineFor('darwin')).toBe('seatbelt')
    expect(engineFor('linux')).toBe('bwrap')
    expect(engineFor('win32')).toBe('none')
    expect(engineFor('freebsd')).toBe('none')
  })

  it('Windows 报的是 available:true:那里不是「机制坏了」而是「没有这种机制」,按 available 分支的消费者会读到假故障', () => {
    const result = interpretProbe('none', ok)
    expect(result.available).toBe(true)
    expect(result.reason).toContain('没有 OS 级的受限执行机制')
  })
})

describe('可用', () => {
  it('探针退出 0 即可用,不给理由:多余的说明会把「一切正常」冲淡', () => {
    expect(interpretProbe('seatbelt', ok)).toEqual({ engine: 'seatbelt', available: true })
    expect(interpretProbe('bwrap', ok)).toEqual({ engine: 'bwrap', available: true })
  })
})

describe('引擎不在', () => {
  it('sandbox-exec 缺失时说清是哪个文件不在:mac 上这只可能是系统被动过,而不是没装', () => {
    const result = interpretProbe('seatbelt', { code: null, failure: 'ENOENT', stderr: '' })
    expect(result.available).toBe(false)
    expect(result.reason).toContain('/usr/bin/sandbox-exec')
  })

  it('bwrap 缺失时说这是包、并给出包名:这一条是 Linux 用户唯一能照做的信息', () => {
    const result = interpretProbe('bwrap', { code: null, failure: 'ENOENT', stderr: '' })
    expect(result.available).toBe(false)
    expect(result.reason).toContain('bubblewrap')
  })

  it('两种缺失都明写「建立不起来」而不是「不工作」:后者会被读成边界装着但没生效', () => {
    for (const engine of ['seatbelt', 'bwrap'] as const) {
      expect(
        interpretProbe(engine, { code: null, failure: 'ENOENT', stderr: '' }).reason
      ).toContain('建立不起来')
    }
  })
})

describe('规则本身编译不过(mac 退出码 65)', () => {
  it('65 单独成一句并把引擎的说明带上:那条探针跑的是生产那份 profile,所以 65 可能是这里的 bug', () => {
    const result = interpretProbe('seatbelt', {
      code: 65,
      stderr: "sandbox-exec: syntax error: expecting ')'\n\nBacktrace: \n<input string>:18:19"
    })
    expect(result.available).toBe(false)
    expect(result.reason).toContain('65')
    expect(result.reason).toContain('没能编译这份边界规则')
    expect(result.reason).toContain('syntax error')
  })

  it('明写「命令都不会被执行,而不是退回不受限地跑」:这是用户看到红字时最容易猜错的方向', () => {
    const result = interpretProbe('seatbelt', {
      code: 65,
      stderr: 'sandbox-exec: unbound variable'
    })
    expect(result.reason).toContain('不会')
    expect(result.reason).toContain('不受限')
  })
})

describe('bwrap 起不来但不缺二进制', () => {
  it('非零退出说命名空间限制并点名 AppArmor:Ubuntu 24.04 起就是这个,不说用户会以为包没装好', () => {
    const result = interpretProbe('bwrap', {
      code: 1,
      stderr: 'bwrap: setting up uid map: Permission denied'
    })
    expect(result.available).toBe(false)
    expect(result.reason).toContain('命名空间')
    expect(result.reason).toContain('AppArmor')
    expect(result.reason).toContain('Permission denied')
  })

  it('明写不走 setuid 那条退路:那是一条静默扩大权限的路,界面上要说它没走', () => {
    expect(interpretProbe('bwrap', { code: 1, stderr: '' }).reason).toContain('setuid')
  })

  it('被信号杀掉时写信号而不是「退出码 null」', () => {
    const result = interpretProbe('bwrap', { code: null, signal: 'SIGSEGV', stderr: '' })
    expect(result.available).toBe(false)
    expect(result.reason).toContain('SIGSEGV')
    expect(result.reason).not.toContain('null')
  })
})

describe('探针自身的死法', () => {
  it('超时报的是毫秒上限:说不清等多久就等于没说这条为什么不阻塞发消息', () => {
    const result = interpretProbe('seatbelt', {
      code: null,
      failure: 'timeout',
      signal: 'SIGTERM',
      stderr: ''
    })
    expect(result.available).toBe(false)
    expect(result.reason).toContain('2000 毫秒')
  })

  it('其它 spawn 错误把原始码写进句子:预检层的猜测不该盖掉内核给的那一条', () => {
    const result = interpretProbe('seatbelt', { code: null, failure: 'EACCES', stderr: '' })
    expect(result.available).toBe(false)
    expect(result.reason).toContain('EACCES')
  })

  it('引擎说明只取第一行并截断:一次探针可能吐一整页,而最后一行在 mac 上是 backtrace 坐标、没有信息量', () => {
    const long = 'bwrap: ' + 'x'.repeat(500) + '\nBacktrace:\n<input string>:18:19'
    const result = interpretProbe('seatbelt', { code: 1, stderr: long })
    expect(result.reason).toContain('bwrap: ' + 'x'.repeat(193))
    expect(result.reason ?? '').not.toContain('x'.repeat(194))
    expect(result.reason ?? '').not.toContain('Backtrace')
  })
})

describe('面向用户的理由都是陈述句', () => {
  it('六种死法各产一句,没有一句写「请 / 务必 / 改用」这类祈使:理由也会被贴进拒绝文案,而模型会把祈使当本轮待办', () => {
    const outcomes: ProbeOutcome[] = [
      ok,
      { code: null, failure: 'ENOENT', stderr: '' },
      { code: 65, stderr: 'boom' },
      { code: 1, stderr: 'boom' },
      { code: null, failure: 'timeout', signal: 'SIGTERM', stderr: 'boom' },
      { code: null, signal: 'SIGKILL', stderr: 'boom' }
    ]
    for (const engine of ['seatbelt', 'bwrap', 'none'] as const) {
      for (const outcome of outcomes) {
        const reason = interpretProbe(engine, outcome).reason ?? ''
        expect(reason).not.toMatch(/请|务必|必须|应该|不要|换用|改用/)
      }
    }
  })
})
