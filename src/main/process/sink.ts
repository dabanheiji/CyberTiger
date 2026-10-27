import type { OutputBill } from './types'

export const DEFAULT_OUTPUT_CHARS = 16_000

/**
 * 头 25% / 尾 75%。
 *
 * 只留末尾是为了「报错通常最后才出现」,但整段开头都丢掉的话,模型会连
 * 「这条命令到底在跑什么、第一行说了什么」都看不到 —— 构建失败时那两句同样承重。
 */
const HEAD_SHARE = 0.25

const STDERR_PREFIX = '[stderr] '

/**
 * 切在半个代理对上会写出一个 U+FFFD,而 `chars` 与实际长度从此对不上账,
 * 「省略了多少字符」那句也会跟着错。所以两个方向都先躲开半个字。
 */
function safeEnd(text: string): string {
  if (!text) return text
  const last = text.charCodeAt(text.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text
}

function safeStart(text: string): string {
  if (!text) return text
  const first = text.charCodeAt(0)
  return first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text
}

/** 头尽量切在行边界上,但只在「切掉一小截」时这么做,不能为了好看丢掉半段内容 */
function cutHead(text: string): string {
  const safe = safeEnd(text)
  const index = safe.lastIndexOf('\n')
  return index >= 0 && index + 1 >= safe.length * 0.6 ? safe.slice(0, index + 1) : safe
}

function cutTail(text: string): string {
  const safe = safeStart(text)
  const index = safe.indexOf('\n')
  return index >= 0 && index + 1 <= safe.length * 0.4 ? safe.slice(index + 1) : safe
}

/** 有界缓冲:边收边丢,不指望进程自己先停下来 */
export class OutputSink {
  private head = ''
  private tail = ''
  private chars = 0
  private lines = 0
  private readonly headCap: number
  private readonly tailCap: number

  constructor(limit = DEFAULT_OUTPUT_CHARS) {
    this.headCap = Math.floor(limit * HEAD_SHARE)
    this.tailCap = limit - this.headCap
  }

  push(text: string): void {
    if (!text) return
    this.chars += text.length
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 10) this.lines += 1
    }

    let rest = text
    if (this.head.length < this.headCap) {
      const need = this.headCap - this.head.length
      this.head += rest.slice(0, need)
      rest = rest.slice(need)
    }
    if (!rest) return
    this.tail += rest
    if (this.tail.length > this.tailCap) {
      this.tail = this.tail.slice(this.tail.length - this.tailCap)
    }
  }

  bill(): OutputBill {
    if (this.chars <= this.headCap + this.tailCap) {
      // 没丢:head + tail 就是全文(第一次没填满 head 时 tail 为空)
      return { head: this.head, tail: this.tail, lines: this.lines, chars: this.chars, dropped: 0 }
    }
    const head = cutHead(this.head)
    const tail = cutTail(this.tail)
    return {
      head,
      tail,
      lines: this.lines,
      chars: this.chars,
      dropped: this.chars - head.length - tail.length
    }
  }
}

/**
 * 两条流合成一条。
 *
 * 分两段存(`stdout:` / `stderr:` 各一块)会丢掉「第 3 行报错紧跟着第 4 行输出」这个先后关系,
 * 而那正是构建失败时最先要看的东西。合并之后靠 `[stderr] ` 前缀做区分:
 * 前缀只在**行首**加,否则每一块 chunk 都会带一个,读起来全是噪声。
 */
export class MergedSink {
  private readonly sink = new OutputSink()
  /** 合并后的文本现在停在行首吗 —— 两条流交替时,只有它知道该不该加前缀 */
  private atLineStart = true

  pushStdout(text: string): void {
    if (!text) return
    this.sink.push(text)
    this.atLineStart = /[\r\n]$/.test(text)
  }

  pushStderr(text: string): void {
    if (!text) return
    const lead = this.atLineStart ? STDERR_PREFIX : ''
    // `(?=.)`:块尾那个换行后面没有内容,别在末尾挂一个空前缀
    const body = text.replace(/(\r\n|\r|\n)(?=.)/g, `$1${STDERR_PREFIX}`)
    this.sink.push(lead + body)
    this.atLineStart = /[\r\n]$/.test(text)
  }

  bill(): OutputBill {
    return this.sink.bill()
  }
}
