import type { ChatCompletionMessage } from '../chat/llm'

/**
 * `beforeRequest` 的改写守卫:钩子可以回一份整份出站消息数组替换它,但先要过这五步。
 *
 * 为什么要有这一层:这段 JSON 来自一个用户自己写的外部程序,而它替换的是**下一步真的要
 * 发给端点的那一份**。结构不合法时端点会按坏协议报错(比丢内容更难排查),而协议一旦被
 * 改出孤儿 `tool_calls`,受害的是整轮上下文 —— 本项目为这一点写过两次单元测试
 * (`agent/turns.ts` 的单元分组、裁剪只动 content 不动 `tool_calls.arguments`),
 * 那两处守的是**生成时**,这里是全项目第一处**运行时**校验:输入不再是自己构造的了。
 *
 * 五步任一不过 ⇒ **整份改写作废、回落原数组**,日志一行 `rewrite-rejected` + 原因。
 * 方向是 fail-open 的那一条:宁可发原本那份,也不发一份没验过的。
 *
 * 本文件零 IO、零 electron,所以那五步和它们的反例都能脱离应用断言。
 */

/** 改写后的条数上限:超了就是钩子在往里灌东西,而不只是「改了一句话」 */
export const MAX_REWRITE_MESSAGES = 2_000

/** 允许的 role;openai 那侧还有 developer / 多模态数组等形状,本项目一个都不构造,所以也不接受 */
const ROLES = ['system', 'user', 'assistant', 'tool'] as const

export interface RewriteInput {
  /** 钩子 stdout 里那份 `messages`,尚未确认是合法 JSON 数组 */
  incoming: unknown
  /** 本步 `planContext` 刚返回、正准备发出去的那一份 */
  original: ChatCompletionMessage[]
  /** 固定在首位、永不参与丢弃的那几条(`system` + 摘要块)的条数 */
  fixed: number
  /** 本步的循环控制消息(收尾提示 / 说明 / 目标锚定),必须原样留在数组末尾 */
  pinned: ChatCompletionMessage[]
}

export interface RewriteResult {
  /** false 时 `history` 是空数组,调用方发原本那一份 */
  accepted: boolean
  /** 拒绝的那一步说清的中文理由,原样进日志;采纳时是空串 */
  reason: string
  /**
   * 采纳时交回的中段:原数组去掉固定头部与末尾 pinned 之后的那一段。
   *
   * 守卫**不返回整份新数组**,因为返回中段之后调用方还要用本步的 `system` / `head` /
   * 重建的 `pinned` 再跑一次 `planContext`。少那一次重裁,钩子塞进来的百万字就会直接
   * 发给端点 —— 「改写 ≠ 越过预算」这条不变量靠这一步成立,不是靠守卫的条数上限。
   */
  history: ChatCompletionMessage[]
}

function reject(reason: string): RewriteResult {
  return { accepted: false, reason, history: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 深度比较两个 JSON 值,**不看对象键的顺序**。
 *
 * 固定头部与 pinned 的比对用它而不是 `JSON.stringify` 全等:钩子把 payload 读进来
 * `JSON.parse` 再原样回传,键顺序在实践中不会变,但任何一次「重新构造对象」都可能变。
 * 那种变化不改变含义,拒绝它等于把一次无害往返报成钩子在动手 —— 而这里要防的是**内容变了**,
 * 不是字节变了。反过来 `tool_calls.arguments` 用的是字符串全等,因为那段是协议的原文,
 * 改了内容就改了工具的语义(见下面 arguments 那一步)。
 */
function equivalent(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => equivalent(item, b[index]))
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    return keys.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && equivalent(a[key], b[key])
    )
  }
  return false
}

/** 一次调用里的 `arguments`:必须是合法 JSON 字符串 —— 坏 JSON 回放时端点按坏参数报错 */
function isValidArguments(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

function toolCallIdsOf(message: Record<string, unknown>): unknown[] {
  const calls = message.tool_calls
  return Array.isArray(calls) ? calls : []
}

/**
 * 逐条检查形状,并把每条 assistant 发起的调用按下标记下来。
 *
 * 返回 null 即形状过关。这一步只管「是不是一个能发的消息」,不管协议配对 —— 配对是第 4 步。
 */
function checkShapes(incoming: unknown): string | null {
  const items = incoming
  if (!Array.isArray(items)) return 'messages 不是数组'
  if (items.length === 0) return 'messages 是空数组'
  if (items.length > MAX_REWRITE_MESSAGES) {
    return `messages 超过 ${String(MAX_REWRITE_MESSAGES)} 条上限`
  }
  for (let i = 0; i < items.length; i++) {
    const message = items[i]
    if (!isRecord(message)) return `第 ${String(i + 1)} 条不是对象`
    const role = message.role
    if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) {
      return `第 ${String(i + 1)} 条的 role 认不出来:${String(role)}`
    }
    const content = message.content
    // undefined 也算过关:纯调用行本来就可以不带正文,拒绝它等于要求钩子补一个空串
    if (typeof content !== 'string' && content !== null && content !== undefined) {
      return `第 ${String(i + 1)} 条的 content 不是字符串`
    }
    if (role === 'tool') {
      const id = message.tool_call_id
      if (typeof id !== 'string' || id === '')
        return `第 ${String(i + 1)} 条工具结果缺少 tool_call_id`
    }
    const calls = toolCallIdsOf(message)
    if (role !== 'assistant' && calls.length > 0) {
      return `第 ${String(i + 1)} 条不是 assistant 却带了 tool_calls`
    }
    for (const raw of calls) {
      if (!isRecord(raw)) return `第 ${String(i + 1)} 条的 tool_call 不是对象`
      if (typeof raw.id !== 'string' || raw.id === '')
        return `第 ${String(i + 1)} 条的 tool_call 缺少 id`
      if (raw.type !== 'function') return `第 ${String(i + 1)} 条的 tool_call 不是 function`
      if (!isRecord(raw.function)) return `第 ${String(i + 1)} 条的 tool_call 缺少 function`
      if (typeof raw.function.name !== 'string' || raw.function.name === '') {
        return `第 ${String(i + 1)} 条的 tool_call 没有函数名`
      }
      if (!isValidArguments(raw.function.arguments)) {
        return `第 ${String(i + 1)} 条的 tool_call 参数不是合法的 JSON 字符串`
      }
    }
  }
  return null
}

/** 原数组里每个调用的 `arguments`,按 id 索引 —— 第 4 步要拿它做逐字节比对 */
function originalArguments(original: ChatCompletionMessage[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const raw of original) {
    if (!isRecord(raw)) continue
    for (const call of toolCallIdsOf(raw)) {
      if (!isRecord(call) || !isRecord(call.function)) continue
      if (typeof call.id === 'string' && typeof call.function.arguments === 'string') {
        map.set(call.id, call.function.arguments)
      }
    }
  }
  return map
}

/**
 * 第 4 步:协议配对。
 *
 * 规则是「一次 assistant 调用后面必须**紧跟**覆盖其全部 id 的连续 tool 行,中间不插别的」,
 * 与 `agent/turns.ts` 的单元边界同一含义 —— 那边保证生成时不拆,这边保证外来数组也没拆。
 * 三种坏形状各有归属:响应缺了(孤儿调用)、响应没人发起(凭空 id)、参数被改(回放会按
 * 一份与库里不一致的参数重跑)。最后一种最容易看漏,因为它结构完全合法。
 */
function checkPairing(items: unknown[], original: ChatCompletionMessage[]): string | null {
  const known = originalArguments(original)
  const consumed = new Set<string>()
  let expected: string[] | null = null

  for (let i = 0; i < items.length; i++) {
    const message = items[i] as Record<string, unknown>
    const role = message.role
    if (role === 'tool') {
      const id = message.tool_call_id as string
      if (expected === null || !expected.includes(id)) {
        // 三种「这条结果没人等」的坏形状要分开说:排查时「钩子凭空编了个 id」
        // 与「它把结果排到了调用前面」是完全不同的写法错误
        if (!known.has(id))
          return `第 ${String(i + 1)} 条工具结果的 ${id} 在原本那份请求里没有对应的调用`
        if (consumed.has(id))
          return `第 ${String(i + 1)} 条工具结果的 ${id} 重复出现:同一次调用被写成做了两次`
        return `第 ${String(i + 1)} 条是工具结果,但前面没有发起它的调用`
      }
      consumed.add(id)
      expected = expected.filter((value) => value !== id)
      if (expected.length === 0) expected = null
      continue
    }
    if (expected !== null) {
      return `第 ${String(i + 1)} 条插在了一个还没收到结果的工具调用中间`
    }
    const calls = toolCallIdsOf(message)
    if (calls.length === 0) continue
    const ids: string[] = []
    for (const raw of calls) {
      const call = raw as Record<string, unknown>
      const fn = call.function as Record<string, unknown>
      const id = call.id as string
      const arguments_ = fn.arguments as string
      if (!known.has(id)) {
        // 「凭空造一个调用」比「删掉一个」危险:前者让端点以为有个工具真的跑过
        return `第 ${String(i + 1)} 条发起的调用 ${id} 不在原本那份请求里`
      }
      if (known.get(id) !== arguments_) {
        return `第 ${String(i + 1)} 条改了调用 ${id} 的参数:那份与库里落下的不一致`
      }
      ids.push(id)
    }
    expected = ids
  }
  return expected === null ? null : '最后一条调用没有对应的工具结果'
}

/** 两条序列在原数组与改写里是否占据同一位置(位置比对,不是内容比对) */
function sameSlot(a: unknown, b: unknown): boolean {
  return equivalent(a, b)
}

/**
 * 一次改写的完整判定。
 *
 * 采纳时只交回**中段**:调用方拿它当新的 `history`,连同本步的 `system` / `head` /
 * 重建后的 `pinned` 再跑一次 `planContext`,于是预算不变量照样成立。
 */
export function acceptRewrite(input: RewriteInput): RewriteResult {
  const { incoming, original, pinned } = input
  const shape = checkShapes(incoming)
  if (shape) return reject(shape)
  const items = incoming as unknown[]

  if (items.length < input.fixed + pinned.length) {
    return reject(
      `改写的条数比「固定头部 + 循环控制消息」还少(${String(input.fixed)} + ${String(pinned.length)})`
    )
  }

  // 第 2 步:固定头部(system + 摘要块)逐字段不许动。
  // 动 system 绕过的不只是前缀缓存,而是整个提示词层:凭据禁令、审批说明都在里面。
  for (let i = 0; i < input.fixed; i++) {
    if (!sameSlot(items[i], original[i])) {
      return reject(`第 ${String(i + 1)} 条是固定头部(系统提示或摘要)的一部分,不允许改写`)
    }
  }

  // 第 3 步:循环控制消息原样留在末尾、同一顺序。
  // 目标锚定靠「近期性」起作用(context.ts 里那条注释是实测结论),被挪走或删掉等于
  // 把「别跑偏」那道护栏关掉;而锚定带着本轮请求原文,所以这一条同时保证请求没被删。
  // 钩子要加话就用 note,守卫之后 loop 会把它拼进 pinned —— 不要动 pinned 本身。
  const tail = items.slice(items.length - pinned.length)
  for (let i = 0; i < pinned.length; i++) {
    if (!sameSlot(tail[i], pinned[i])) {
      return reject(
        `末尾第 ${String(i + 1)} 条是本轮的循环控制消息(收尾提示 / 说明 / 目标锚定),不允许改写`
      )
    }
  }

  const pairing = checkPairing(items, original)
  if (pairing) return reject(pairing)

  const history = items.slice(input.fixed, items.length - pinned.length) as ChatCompletionMessage[]
  return { accepted: true, reason: '', history }
}
