import XMarkdown from '@ant-design/x-markdown'
import { Typography, theme } from 'antd'
import type { AgentStep, StreamingToolCall } from '../lib/agentSteps'
import ReasoningBox from './ReasoningBox'
import ToolCallChain from './ToolCallChain'

interface AgentStepsProps {
  steps: AgentStep[]
  /** 这组步骤所属的 run 仍在进行中 */
  streaming: boolean
}

/**
 * 渲染 Agent 一次回复的产出:一个思考框 + 一条工具链 + 若干段正文。
 *
 * 一次回复只给一套,而不是按 ReAct 的每一步各给一套 —— 逐步渲染会让多步回合变成
 * 一长串重复的「深度思考」,信息密度反而更低,也看不出哪段思考对应哪次行动。
 * 主气泡与子 Agent 面板共用此组件,子 Agent 面板里会递归渲染它自己。
 */
function AgentSteps({ steps, streaming }: AgentStepsProps): React.JSX.Element {
  // 各步的思考按顺序拼进同一个框
  const reasoning = steps
    .map((step) => step.reasoning)
    .filter(Boolean)
    .join('\n\n')
  // 各步发起的工具调用按顺序排进同一条链
  const toolCalls = steps.flatMap((step) => step.toolCalls)
  const contents = steps
    .filter((step) => step.content)
    .map((step) => ({ id: step.messageId, text: step.content }))
  // "还在思考"按整个回复判断:一旦产出正文就收起。
  // 若按单步判断,每进入新的一步都会重新展开再折叠,闪得厉害。
  const thinking = streaming && contents.length === 0

  return (
    <>
      {!!reasoning && <ReasoningBox reasoning={reasoning} thinking={thinking} />}
      {toolCalls.length > 0 && (
        <ToolCallChain
          calls={toolCalls}
          renderDetail={(call) => (call.agentSteps?.length ? <SubAgentDetail call={call} /> : null)}
        />
      )}
      {contents.map((item) => (
        <XMarkdown key={item.id} content={item.text} />
      ))}
    </>
  )
}

interface SubAgentDetailProps {
  call: StreamingToolCall
}

/**
 * 子 Agent 的执行过程,嵌在发起它的那次 task 调用里。
 * 折叠由外层的工具调用项统一控制,这里只负责缩进与角色标注。
 */
function SubAgentDetail({ call }: SubAgentDetailProps): React.JSX.Element {
  const { token } = theme.useToken()
  return (
    <div
      style={{
        marginTop: 8,
        paddingLeft: 12,
        borderLeft: `2px solid ${token.colorBorderSecondary}`
      }}
    >
      {!!call.agentName && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          子 Agent 角色:{call.agentName}
        </Typography.Text>
      )}
      <AgentSteps steps={call.agentSteps ?? []} streaming={call.status === 'running'} />
    </div>
  )
}

export default AgentSteps
