import type { AskUserAnswer, AskUserQuestion } from '../chat/dto'
import type { ToolDefinition } from '../tools/types'

export const ASK_USER_TOOL_NAME = 'ask_user'

/** 候选项的上限:再多也只是把一张卡片变成一屏,用户看不清也选不完 */
const OPTIONS_MAX = 6

/** 把提问送到渲染层并等用户的作答;由 service 现构造(它才握着 emit、scope 与本次 run 的 signal) */
export type AskUserHandler = (question: AskUserQuestion, callId: string) => Promise<AskUserAnswer>

/**
 * 一个候选项的文本。
 * 模型可能给纯字符串,也可能给 `{ label, description }` 那种带说明的形状(它的训练数据里
 * 两种都有):只认 label,说明文字丢掉 —— 界面上选项就是要能直接当答案的那句话。
 */
function optionText(item: unknown): string {
  if (typeof item === 'string') return item.trim()
  if (item !== null && typeof item === 'object') {
    const label = (item as { label?: unknown }).label
    if (typeof label === 'string') return label.trim()
  }
  return ''
}

/** 去掉空项与重复项:重复的选项在界面上是两条一模一样的Radio,点了也不知道选了哪条 */
function normalizeOptions(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen: string[] = []
  for (const item of value) {
    const text = optionText(item)
    if (!text || seen.includes(text)) continue
    seen.push(text)
    if (seen.length >= OPTIONS_MAX) break
  }
  return seen
}

/**
 * 把用户的作答写成给模型看的文本,全部用陈述句。
 *
 * 不写「请据此继续」「请再确认一次」这类祈使:模型会把它当成本轮待办去执行,
 * 这个项目在工具结果文案上踩过两次同样的坑(见 AGENTS.md 的错误处理一条)。
 * 三种形状各说一件事:选了什么、用户跳过了、这一轮已经中止。
 */
export function describeAnswer(answer: AskUserAnswer): string {
  if (answer === null) return '[本轮已中止,没有拿到用户的回答]'
  const picked = answer.map((item) => item.trim()).filter(Boolean)
  if (picked.length === 0) return '[用户跳过了这个问题,没有给出选择]'
  return `用户的回答:${picked.map((item) => `「${item}」`).join('、')}`
}

/**
 * 提问工具:模型在几个都合理的方案之间请用户拍板,run 阻塞在这次调用上等他的选择。
 *
 * 与 task 一样按 run 现构造(闭包握住提问通道),所以不进 builtinTools —— 附带两个好处:
 * 子 Agent 的工具池天然不含它(子 Agent 的上下文里没有用户),而设置里子 Agent 的工具
 * 白名单也不会列出这个选了也无效的选项。
 */
export function createAskUserTool(ask: AskUserHandler): ToolDefinition {
  return {
    name: ASK_USER_TOOL_NAME,
    description:
      '向用户提出一个问题并等他在界面上选择,用于只有用户那边才有答案的分叉:' +
      '需求含糊、有几个都合理的方案、要改动的范围或文件不确定、需要用户确认取舍。' +
      'question 是一句话说清在什么之间做选择;options 是 2 到 4 个可以直接当答案的短语;' +
      'multiSelect 为 true 时用户可以多选。' +
      '界面会自动提供一个自己输入的位置,所以候选项里不必自己加「其他」。' +
      '一次调用只问一个问题,要问几件事就分几次调用。' +
      '不适合:能自己决定的实现细节、能从工具结果里查到的事实,以及用户已经回答过的内容 ——' +
      '同一轮里重复提出的问题不会再次弹出,系统直接复用第一次的答案。',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '要问用户的话,一句话说清在哪些做法之间选'
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '候选答案,2 到 4 条,每条本身就能当答案;不要写编号或前缀'
        },
        multiSelect: {
          type: 'boolean',
          description: 'true 表示用户可以同时选多项;缺省为单选'
        }
      },
      required: ['question', 'options']
    },
    execute: async (args, context): Promise<string> => {
      const question = String(args.question ?? '').trim()
      if (!question) throw new Error('缺少 question:要问用户的话得写清楚')
      const asked: AskUserQuestion = {
        question,
        options: normalizeOptions(args.options),
        multiSelect: args.multiSelect === true
      }
      // callId 由工具上下文给出:渲染层靠它在同一次调用的结果到手时收起卡片
      return describeAnswer(await ask(asked, context.callId))
    }
  }
}
