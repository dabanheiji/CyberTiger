import { useState } from 'react'
import { Button, Checkbox, Flex, Input, Radio, Tooltip, Typography, theme } from 'antd'
import { QuestionCircleOutlined } from '@ant-design/icons'
import { submittedAnswers } from '../lib/askUser'

interface AskUserCardProps {
  question: string
  options: string[]
  multiSelect: boolean
  /** answers 为空数组即「跳过这个问题」 */
  onAnswer: (answers: string[]) => void
}

/**
 * 模型请用户做选择的那张卡片,显示在输入框上方。
 *
 * 放在输入框上面而不是气泡里:这一轮正阻塞在这次提问上,用户此刻的注意力本来就在输入区,
 * 而气泡会随流式内容往上滚 —— 卡片滚出视野等于这一轮没法继续。
 */
function AskUserCard({
  question,
  options,
  multiSelect,
  onAnswer
}: AskUserCardProps): React.JSX.Element {
  const { token } = theme.useToken()
  const [selected, setSelected] = useState<string[]>([])
  const [freeText, setFreeText] = useState('')
  // 提交之后到那次工具结果到手之间 run 还阻塞着:这段窗口里不让连点起第二次提交
  const [submitted, setSubmitted] = useState(false)
  const answers = submittedAnswers({ selected, freeText })

  const send = (value: string[]): void => {
    if (submitted) return
    setSubmitted(true)
    onAnswer(value)
  }

  const toggle = (option: string, checked: boolean): void => {
    if (multiSelect) {
      setSelected((prev) => (checked ? [...prev, option] : prev.filter((item) => item !== option)))
      return
    }
    setSelected(checked ? [option] : [])
  }

  return (
    <div
      style={{
        marginBottom: token.marginSM,
        padding: token.paddingSM,
        border: `1px solid ${token.colorPrimaryBorder}`,
        borderRadius: token.borderRadiusLG,
        background: token.colorBgContainer
      }}
    >
      <Flex vertical gap={token.marginXS}>
        <Flex align="center" gap={token.marginXXS}>
          <QuestionCircleOutlined style={{ color: token.colorPrimary }} />
          <Typography.Text strong>需要你选一下</Typography.Text>
        </Flex>
        <Typography.Text>{question}</Typography.Text>
        {/* 一行一个:候选项是拿来比较的,横向铺开就看不出区别 */}
        <Flex vertical gap={token.marginXXS}>
          {options.map((option) =>
            multiSelect ? (
              <Checkbox
                key={option}
                checked={selected.includes(option)}
                onChange={(e) => toggle(option, e.target.checked)}
              >
                {option}
              </Checkbox>
            ) : (
              <Radio
                key={option}
                checked={selected.includes(option)}
                onChange={(e) => toggle(option, e.target.checked)}
              >
                {option}
              </Radio>
            )
          )}
        </Flex>
        {/* 最后一项永远是用户自己写:候选再全也覆盖不到他没想到的那种做法 */}
        <Input
          value={freeText}
          placeholder="其他:自己输入"
          disabled={submitted}
          onChange={(e) => setFreeText(e.target.value)}
          onKeyDown={(e) => {
            // 输入法选词那次回车不算提交:不然拼音还没上屏就被当成答案发出去了
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) send(answers)
          }}
        />
        <Flex justify="flex-end" gap={token.marginXXS}>
          <Tooltip title="不给选择,让模型按自己的判断继续">
            <Button size="small" disabled={submitted} onClick={() => send([])}>
              跳过
            </Button>
          </Tooltip>
          <Button
            size="small"
            type="primary"
            disabled={answers.length === 0 || submitted}
            onClick={() => send(answers)}
          >
            提交
          </Button>
        </Flex>
      </Flex>
    </div>
  )
}

export default AskUserCard
