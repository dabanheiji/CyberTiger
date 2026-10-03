import type { ModelRef } from '../../../main/store/types'

/**
 * Select 的 value 必须是字符串,而一个模型由「服务商 + 模型名」共同确定,
 * 所以拼一个复合键。分隔符取不可见字符 U+0000:模型 ID 里不会出现,不用做转义。
 * 这个键纯粹是界面细节,不会写进存储 —— 存储里是结构化的 ModelRef。
 */
const SEP = '\u0000'

export function modelKey(ref: ModelRef): string {
  return `${ref.providerId}${SEP}${ref.model}`
}

export function parseModelKey(key: string): ModelRef {
  const at = key.indexOf(SEP)
  return { providerId: key.slice(0, at), model: key.slice(at + 1) }
}
