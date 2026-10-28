import { BufferSink, MergedSink, OutputSink } from '../../../src/main/process/sink'

function textOf(sink: OutputSink): string {
  const bill = sink.bill()
  return bill.head + bill.tail
}

describe('OutputSink:有界缓冲', () => {
  it('短输出原样留下,账目为零', () => {
    const sink = new OutputSink(100)
    sink.push('hello\nworld\n')
    const bill = sink.bill()
    expect(bill.head + bill.tail).toBe('hello\nworld\n')
    expect(bill.dropped).toBe(0)
    expect(bill.chars).toBe(12)
    expect(bill.lines).toBe(2)
  })

  it('超长输出保头保尾,省掉的字符数与自己声称的完全对得上', () => {
    const sink = new OutputSink(100)
    sink.push(`${'a'.repeat(40)}\n${'b'.repeat(400)}`)
    const bill = sink.bill()
    expect(bill.head.startsWith('a')).toBe(true)
    expect(bill.tail.endsWith('b')).toBe(true)
    expect(bill.head.length + bill.tail.length).toBeLessThanOrEqual(100)
    // 这条账目是给用户看的「省了多少」,算错就是谎报
    expect(bill.dropped).toBe(bill.chars - bill.head.length - bill.tail.length)
    expect(bill.dropped).toBeGreaterThan(0)
  })

  it('头尽量切在行边界上:半行开头读起来像命令自己截断了', () => {
    const sink = new OutputSink(100)
    sink.push(`${'a'.repeat(20)}\n${'b'.repeat(20)}\n${'c'.repeat(200)}`)
    const bill = sink.bill()
    expect(bill.head.endsWith('\n')).toBe(true)
    expect(bill.head).not.toContain('c')
  })

  it('不把代理对切成两半:半个字会变成替换符,省略的字符数也跟着错', () => {
    const sink = new OutputSink(100)
    // 先补一个奇数长度,让 25% 的切点正好落在某个 emoji 中间
    sink.push(`a${'😀'.repeat(200)}`)
    const bill = sink.bill()
    const last = bill.head.charCodeAt(bill.head.length - 1)
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    const first = bill.tail.charCodeAt(0)
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false)
    expect(textOf(sink)).not.toContain('\uFFFD')
  })
})

describe('MergedSink:两条流的合并', () => {
  it('stderr 的每一行都带前缀,收尾不会留下一个空前缀', () => {
    const sink = new MergedSink()
    sink.pushStdout('a\n')
    sink.pushStderr('b\nc\n')
    const bill = sink.bill()
    expect(bill.head + bill.tail).toBe('a\n[stderr] b\n[stderr] c\n')
  })

  it('同一行被拆成两块时只在前缀一次:否则每块 chunk 都冒出一句', () => {
    const sink = new MergedSink()
    sink.pushStderr('bo')
    sink.pushStderr('om\n')
    expect(sink.bill().head).toBe('[stderr] boom\n')
  })

  it('stdout 本身不加前缀;它以换行结尾时,紧随其后的 stderr 仍从行首起算', () => {
    const sink = new MergedSink()
    sink.pushStdout('only out\n')
    sink.pushStderr('only err')
    const bill = sink.bill()
    expect(bill.head + bill.tail).toBe('only out\n[stderr] only err')
  })

  it('两行 stderr 中间夹着 stdout 时,前缀仍落在各自行首', () => {
    const sink = new MergedSink()
    sink.pushStderr('first\n')
    sink.pushStdout('middle\n')
    sink.pushStderr('second\n')
    expect(sink.bill().head).toBe('[stderr] first\nmiddle\n[stderr] second\n')
  })
})

describe('BufferSink:原始输出,要么完整要么作废', () => {
  it('没越上限时 stdout 就是逐字原文:钩子回执是 JSON,前缀与挖洞都会让它解析不了', () => {
    const sink = new BufferSink(128)
    sink.pushStdout('{')
    sink.pushStdout('"note":"第一行\n第二行"}')
    expect(sink.stdout).toBe('{"note":"第一行\n第二行"}')
    const bill = sink.bill()
    // 这份 bill 只是 ProcOutcome 的通用形状:整段在 head,tail 永远是空的
    expect(bill.head).toBe(sink.stdout)
    expect(bill.tail).toBe('')
    expect(bill.dropped).toBe(0)
    expect(bill.lines).toBe(1)
    expect(bill.chars).toBe(Buffer.byteLength(sink.stdout, 'utf8'))
  })

  it('越过上限时整段作废而不是留一头一尾:半截 JSON 不是「短一点的结论」,是「没有结论」', () => {
    const sink = new BufferSink(16)
    sink.pushStdout('a'.repeat(10))
    expect(sink.stdout).toBe('a'.repeat(10))
    sink.pushStdout('b'.repeat(10))
    expect(sink.overflow).toBe(true)
    expect(sink.stdout).toBe('')
    const bill = sink.bill()
    expect(bill.head).toBe('')
    expect(bill.tail).toBe('')
    // 作废的账要自己说得清:丢的就是全部,而不是「中间那一段」
    expect(bill.chars).toBe(20)
    expect(bill.dropped).toBe(bill.chars)
  })

  it('作废之后仍把账记完但不再存内容:一个刷屏的钩子不能把主进程压在一个 GB 级字符串上', () => {
    const sink = new BufferSink(16)
    sink.pushStdout('xxxxxxxx\n')
    for (let index = 0; index < 500; index += 1) sink.pushStdout(`${'y'.repeat(64)}\n`)
    expect(sink.overflow).toBe(true)
    expect(sink.stdout).toBe('')
    const bill = sink.bill()
    expect(bill.lines).toBe(501)
    expect(bill.chars).toBeGreaterThan(32_000)
    expect(bill.dropped).toBe(bill.chars)
  })

  it('上限按 UTF-8 字节算,与管道那一边量的同一个东西:按 code unit 算会把三个汉字当三个字节', () => {
    const sink = new BufferSink(9)
    sink.pushStdout('哈哈哈')
    expect(sink.stdout).toBe('哈哈哈')
    expect(sink.bill().chars).toBe(9)
    sink.pushStdout('哈')
    expect(sink.overflow).toBe(true)
  })

  it('stderr 单独一处、到上限就停手:它只是日志线索,不值得为它把 stdout 一起废掉', () => {
    const sink = new BufferSink(64, 16)
    sink.pushStderr('0123456789ABCDE')
    sink.pushStderr('F')
    sink.pushStderr('后面这些进不去了')
    expect(sink.stderr).toBe('0123456789ABCDEF')
    expect(sink.overflow).toBe(false)
    expect(sink.stdout).toBe('')
  })

  it('空白与空串不算越界:一条只输出换行的钩子仍然拿到自己那句原文', () => {
    const sink = new BufferSink(8)
    sink.pushStdout('')
    sink.pushStdout('\n')
    expect(sink.stdout).toBe('\n')
    expect(sink.overflow).toBe(false)
    expect(sink.bill().lines).toBe(1)
  })
})
