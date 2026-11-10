/**
 * 终端输出的定长回放缓冲。只在头部裁剪,读出来是一段可直接写进 xterm 的字符串。
 *
 * 裁剪点若落在代理对中间就往后挪一个字符 —— 半个 emoji / 生僻字会让 xterm 显示成方块,
 * 而回放是重载后第一眼看到的东西,不该从一屏乱码开始。
 */
export class Backlog {
  private readonly limit: number
  private text = ''

  constructor(limit: number) {
    this.limit = Math.max(1, limit)
  }

  append(chunk: string): void {
    if (!chunk) return
    this.text += chunk
    if (this.text.length <= this.limit) return
    let cut = this.text.length - this.limit
    if (isLowSurrogate(this.text.charCodeAt(cut))) cut += 1
    this.text = this.text.slice(cut)
  }

  toString(): string {
    return this.text
  }

  get length(): number {
    return this.text.length
  }
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}
