import {
  estimateJsonTokens,
  estimateMessageTokens,
  estimateRequestTokens,
  estimateTextTokens,
  estimateToolsTokens,
  formatTokens
} from '../../../src/main/tokens/estimate'
import type { ChatCompletionMessage, ChatCompletionTool } from '../../../src/main/chat/llm'

/** 只关心 name / parameters,估算器只读 tool.function 这一层 */
function tool(name: string): ChatCompletionTool {
  return { type: 'function', function: { name } } as unknown as ChatCompletionTool
}

describe('estimateTextTokens', () => {
  it('空文本算 0', () => {
    expect(estimateTextTokens('')).toBe(0)
  })

  it('英文按 4 字符 1 token 并向上取整', () => {
    expect(estimateTextTokens('abcd')).toBe(1)
    expect(estimateTextTokens('abcde')).toBe(2)
    expect(estimateTextTokens('abcdefgh')).toBe(2)
  })

  it('中文与全角标点按 1 字 1 token', () => {
    expect(estimateTextTokens('你好')).toBe(2)
    expect(estimateTextTokens('你好，世界')).toBe(5)
  })

  it('中英混排各按各的系数相加', () => {
    // 2 个汉字 + 3 个字母 → 2 + ceil(0.75) = 3
    expect(estimateTextTokens('你好abc')).toBe(3)
  })

  it('可以按内容类型指定 charsPerToken', () => {
    expect(estimateTextTokens('abcdefgh', 8)).toBe(1)
    // JSON 折得更狠:同样 12 字符按 3 字符 1 token
    expect(estimateTextTokens('{}{}{}{}{}{}', 3)).toBe(4)
  })

  it('代理对字符不会崩,按 UTF-16 长度折算', () => {
    expect(estimateTextTokens('😀')).toBe(1)
  })
})

describe('estimateJsonTokens', () => {
  it('序列化后按 3 字符 1 token', () => {
    // {"a":1} 7 字符 → ceil(7 / 3) = 3
    expect(estimateJsonTokens({ a: 1 })).toBe(3)
  })

  it('undefined 序列化结果是空,算 0', () => {
    expect(estimateJsonTokens(undefined)).toBe(0)
  })

  it('循环引用退回 String(value),不抛错', () => {
    const value: Record<string, unknown> = { n: 1 }
    value.self = value
    // '[object Object]' → ceil(15 / 3) = 5
    expect(estimateJsonTokens(value)).toBe(5)
  })
})

describe('estimateMessageTokens', () => {
  it('每条消息都有固定开销', () => {
    expect(estimateMessageTokens({ role: 'user', content: '你好' })).toBe(6)
    expect(estimateMessageTokens({ role: 'assistant', content: null })).toBe(4)
  })

  it('可选的 name 也计入', () => {
    expect(estimateMessageTokens({ role: 'user', name: 'Alice', content: '' })).toBe(6)
  })

  it('把发起的工具调用一起算进去', () => {
    const message: ChatCompletionMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'get_time', arguments: '{}' }
        }
      ]
    }
    // 开销 4 + 调用开销 8 + 名字 ceil(8/4)=2 + 参数 ceil(2/3)=1
    expect(estimateMessageTokens(message)).toBe(15)
  })

  it('SDK 的 custom 调用分支也算得到', () => {
    // 只给 id / name / arguments 的形状(项目里的 ToolCallRecord),走 describeCall 的兜底
    const message = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call-1', name: 'ab', arguments: '{}' }]
    } as unknown as ChatCompletionMessage
    expect(estimateMessageTokens(message)).toBe(4 + 8 + 1 + 1)
  })

  it('多模态数组只算文本部分', () => {
    const message: ChatCompletionMessage = {
      role: 'user',
      content: [
        { type: 'text', text: '你好' },
        { type: 'image_url', image_url: { url: 'https://x/y.png' } }
      ]
    }
    expect(estimateMessageTokens(message)).toBe(4 + 2)
  })
})

describe('estimateToolsTokens 与 estimateRequestTokens', () => {
  it('每个工具按整份 function JSON 加一份开销', () => {
    // {"name":"a"} 12 字符 → 4 token,再加每条 4 的开销
    expect(estimateToolsTokens([tool('a')])).toBe(8)
    expect(estimateToolsTokens([tool('a'), tool('b')])).toBe(16)
  })

  it('请求 = 消息 + 工具定义 + 回复预留', () => {
    const messages: ChatCompletionMessage[] = [{ role: 'user', content: '你好' }]
    expect(estimateRequestTokens(messages, [tool('a')])).toBe(6 + 8 + 3)
  })

  it('空工具列表不计工具开销', () => {
    const messages: ChatCompletionMessage[] = [{ role: 'user', content: '你好' }]
    expect(estimateRequestTokens(messages)).toBe(9)
    expect(estimateRequestTokens(messages, [])).toBe(9)
  })
})

describe('formatTokens', () => {
  it('1000 以内原样显示', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
  })

  it('整千数不带小数尾巴', () => {
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(2000)).toBe('2k')
  })

  it('其余保留一位小数', () => {
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(12345)).toBe('12.3k')
  })
})
