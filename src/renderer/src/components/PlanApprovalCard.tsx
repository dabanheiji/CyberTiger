import { useState } from 'react'
import { Button, Flex, Input, Tag, Typography, theme } from 'antd'
import { FileTextOutlined } from '@ant-design/icons'
import type { GlobalToken } from 'antd'
import Markdown from './Markdown'

interface PlanApprovalCardProps {
  /** 待审批的计划正文(markdown);批准后服务端原样落盘 */
  plan: string
  /** 修订次数:第一次生成的草稿是 0 */
  revision: number
  /** 当前会话的工作空间;只用来把「批准后存到哪儿」说准 */
  workspace: string
  /** 规划 / 修订 / 批准正在进行中:整张卡片禁用 */
  busy: boolean
  onApprove: () => void
  onRevise: (feedback: string) => void
  onDiscard: () => void
}

/** 计划预览区:长计划要能滚,但不能把输入框挤出视野 */
function previewStyle(token: GlobalToken): React.CSSProperties {
  return {
    maxHeight: '40vh',
    overflow: 'auto',
    padding: '8px 12px',
    background: token.colorFillQuaternary,
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: token.borderRadiusSM
  }
}

/**
 * 待审批计划的卡片,压在输入框上方。
 *
 * 与 AskUserCard / ApprovalCard 同一个位置、同一条理由:这一轮停在用户身上,而气泡会随
 * 流式内容滚出视野。计划文件在按下「批准」之前**不会落盘** —— 用户看到的就是将要执行的那一份。
 */
function PlanApprovalCard({
  plan,
  revision,
  workspace,
  busy,
  onApprove,
  onRevise,
  onDiscard
}: PlanApprovalCardProps): React.JSX.Element {
  const { token } = theme.useToken()
  const [feedback, setFeedback] = useState('')
  const canRevise = feedback.trim() !== '' && !busy
  const saveNote = workspace
    ? `批准后计划保存到 ${workspace}/.cybertiger/plans,任务清单保存在 .cybertiger/tasks`
    : '批准后计划保存到应用数据目录的 plans/,任务清单保存在 tasks'

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
        <Flex align="center" gap={token.marginXXS} wrap>
          <FileTextOutlined style={{ color: token.colorPrimary }} />
          <Typography.Text strong>实施计划待审批</Typography.Text>
          {revision > 0 && (
            <Tag color="blue" style={{ marginInlineStart: 4 }}>
              第 {revision} 次修订
            </Tag>
          )}
        </Flex>

        <div style={previewStyle(token)}>
          <Markdown content={plan} />
        </div>

        <Flex vertical gap={token.marginXXS}>
          <Input.TextArea
            value={feedback}
            autoSize={{ minRows: 2, maxRows: 5 }}
            placeholder="哪里需要改?写下修改意见后点「按建议重新生成」"
            disabled={busy}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <Flex align="center" gap={token.marginXXS}>
            <Button size="small" disabled={!canRevise} onClick={() => onRevise(feedback.trim())}>
              按建议重新生成
            </Button>
            <Button size="small" disabled={busy} onClick={onDiscard}>
              放弃计划
            </Button>
            <Button size="small" type="primary" disabled={busy} onClick={onApprove}>
              批准并开始实施
            </Button>
          </Flex>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {saveNote}。批准后主 Agent 先把计划拆成任务写进 task.md,每完成一步勾掉一项。
          </Typography.Text>
        </Flex>
      </Flex>
    </div>
  )
}

export default PlanApprovalCard
