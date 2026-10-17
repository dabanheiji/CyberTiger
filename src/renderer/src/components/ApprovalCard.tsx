import { useState } from 'react'
import { Button, Flex, Input, Tag, Tooltip, Typography, theme } from 'antd'
import { ExclamationCircleOutlined } from '@ant-design/icons'
import type { GlobalToken } from 'antd'
import type { ApprovalOutcome, ApprovalRequest } from '../../../main/chat/dto'

interface ApprovalCardProps {
  request: ApprovalRequest
  /** reason 只在 outcome 为 deny 时有意义,空串即「没给理由」 */
  onDecide: (outcome: ApprovalOutcome, reason: string) => void
  /** 「加入白名单」:本期只跳到设置页,不在卡片里就地写名单(名单就会有两处真值) */
  onOpenWhitelist: () => void
}

/** 三档风险的标签:用户靠它一眼看出「这条是要紧事还是例行问一句」 */
const RISK_TAGS: Record<ApprovalRequest['risk'], { label: string; color: string }> = {
  low: { label: '低风险', color: 'blue' },
  elevated: { label: '中高风险', color: 'orange' },
  listed: { label: '命中黑名单', color: 'red' }
}

/**
 * 命令行 / 路径显示成一块等宽文本。
 *
 * 长命令不能折行:折了以后 `rm -rf` 与参数分在两行,恰恰看不出它在干什么。
 * 所以横向滚动 + 可选中复制(卡片要能核对原文,不只是看个摘要就点允许)。
 */
function commandStyle(token: GlobalToken): React.CSSProperties {
  return {
    margin: 0,
    padding: '6px 10px',
    overflowX: 'auto',
    whiteSpace: 'pre',
    fontSize: 12,
    fontFamily: token.fontFamilyCode,
    background: token.colorFillQuaternary,
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: token.borderRadiusSM
  }
}

/**
 * 一次工具调用的审批卡片,显示在输入框上方。
 *
 * 位置与 AskUserCard 同一条理由:这一轮正阻塞在这条命令上,而气泡会随流式内容滚出视野。
 * 边框用警告色而不是主色:它要的是「停下来看清再按」,不是「有个问题在等你选」。
 */
function ApprovalCard({
  request,
  onDecide,
  onOpenWhitelist
}: ApprovalCardProps): React.JSX.Element {
  const { token } = theme.useToken()
  const [reason, setReason] = useState('')
  // 按下到那次工具结果到手之间 run 还阻塞着:这段窗口不让连点起第二次决定
  const [submitted, setSubmitted] = useState(false)
  const risk = RISK_TAGS[request.risk]

  const send = (outcome: ApprovalOutcome): void => {
    if (submitted) return
    setSubmitted(true)
    onDecide(outcome, outcome === 'deny' ? reason.trim() : '')
  }

  return (
    <div
      style={{
        marginBottom: token.marginSM,
        padding: token.paddingSM,
        border: `1px solid ${token.colorWarningBorder}`,
        borderRadius: token.borderRadiusLG,
        background: token.colorBgContainer
      }}
    >
      <Flex vertical gap={token.marginXS}>
        <Flex align="center" gap={token.marginXXS}>
          <ExclamationCircleOutlined style={{ color: token.colorWarning }} />
          <Typography.Text strong>需要你审批</Typography.Text>
          <Tag color={risk.color} style={{ marginInlineStart: 4 }}>
            {risk.label}
          </Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {request.tool}
          </Typography.Text>
        </Flex>

        {/* summary 本身就是一句话(「执行命令:npm run build」),用 pre 显示就不再折行;
            再配一行正文渲染等于同一句写两遍 */}
        <pre style={commandStyle(token)}>{request.summary}</pre>

        {request.detail.length > 0 && (
          <Flex vertical gap={0}>
            {request.detail.map((line) => (
              <Typography.Text key={line} type="secondary" style={{ fontSize: 12 }}>
                · {line}
              </Typography.Text>
            ))}
          </Flex>
        )}

        <Flex vertical gap={token.marginXXS}>
          {/* 「本轮同类都允许」放行的是整整一类,不是这一条,所以键必须写在按钮上:
              按下去之前就得让人看见范围(键里带目录,全写在 Tooltip 里) */}
          <Tooltip title={`本轮不再问这一类:${request.runAllowKey}`}>
            <Button size="small" disabled={submitted} onClick={() => send('allow_run')}>
              <span
                style={{
                  maxWidth: 220,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                  verticalAlign: 'bottom'
                }}
              >
                {`本轮不再问「${request.runAllowKey}」`}
              </span>
            </Button>
          </Tooltip>
          <Flex align="center" gap={token.marginXXS}>
            <Input
              size="small"
              style={{ flex: 1 }}
              value={reason}
              placeholder="拒绝时说说为什么(会原样转告模型)"
              disabled={submitted}
              onChange={(e) => setReason(e.target.value)}
            />
            <Button size="small" danger disabled={submitted} onClick={() => send('deny')}>
              拒绝
            </Button>
            <Button size="small" type="primary" disabled={submitted} onClick={() => send('allow')}>
              允许一次
            </Button>
          </Flex>
          <Typography.Link style={{ fontSize: 12 }} onClick={onOpenWhitelist}>
            把这一条加入白名单(到设置页的「权限」里编辑)
          </Typography.Link>
        </Flex>
      </Flex>
    </div>
  )
}

export default ApprovalCard
