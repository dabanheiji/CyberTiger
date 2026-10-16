import { submittedAnswers } from '../../../src/renderer/src/lib/askUser'

describe('submittedAnswers:卡片交给主进程的答案', () => {
  it('只勾选项时按勾选顺序交出', () => {
    expect(submittedAnswers({ selected: ['加索引', '分表'], freeText: '' })).toEqual([
      '加索引',
      '分表'
    ])
  })

  it('写了自由输入就只交那一句:打字说明候选里没有他要的那个', () => {
    // 先前点过的那一项常常只是鼠标路过留下的,和自由输入并存会让模型收到两个矛盾的答案
    expect(submittedAnswers({ selected: ['用 SQLite'], freeText: '先用 CSV 顶着' })).toEqual([
      '先用 CSV 顶着'
    ])
  })

  it('自由输入去掉首尾空白:换行与空格不是答案的一部分', () => {
    expect(submittedAnswers({ selected: [], freeText: '  改成两阶段提交 \n' })).toEqual([
      '改成两阶段提交'
    ])
  })

  it('什么都没填时是空数组,即「跳过这个问题」', () => {
    expect(submittedAnswers({ selected: [], freeText: '   ' })).toEqual([])
  })

  it('勾选项里的空白项被丢掉:不会因为一条空答案让提交按钮以为有内容', () => {
    expect(submittedAnswers({ selected: ['', '  ', '甲'], freeText: '' })).toEqual(['甲'])
  })
})
