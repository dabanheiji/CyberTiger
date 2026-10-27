import { MergedSink, OutputSink } from '../../../src/main/process/sink'

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
