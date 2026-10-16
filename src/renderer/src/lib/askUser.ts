/**
 * 提交时交给主进程的答案。
 *
 * 自由输入一旦写了字就覆盖勾选:用户在那儿打字说明候选项里没有一个是他要的,
 * 先前点过的那一项只是鼠标路过留下的。
 * 空数组是「跳过」—— 主进程照样把这次等待了结,好让模型知道用户没给选择,
 * 而不是让这一轮永远悬在 ask_user 上。
 */
export function submittedAnswers(input: { selected: string[]; freeText: string }): string[] {
  const text = input.freeText.trim()
  if (text) return [text]
  return input.selected.map((item) => item.trim()).filter(Boolean)
}
