import { useState } from 'react'
import { Bubble, Sender, Suggestion, Welcome } from '@ant-design/x'
import type { BubbleListProps } from '@ant-design/x'
import XMarkdown from '@ant-design/x-markdown'
import { Avatar, Button, Flex, Select, Tag, theme } from 'antd'
import {
  RobotOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  UserOutlined
} from '@ant-design/icons'
import type { Message } from '../../../../main/chat/sql'
import type { ModelProvider, ModelRef } from '../../../../main/store/types'
import { modelKey, parseModelKey } from '../../lib/modelRef'
import type { AgentStep, StreamingRun, StreamingToolCall } from '../../hooks/useAgentStream'
import { attachToolResult, finalizeStep, findCall } from '../../lib/agentSteps'
import { useSkills } from '../../hooks/useSkills'
import AgentSteps from '../../components/AgentSteps'

/** 交给气泡 contentRender 的内容 */
interface UserBubbleContent {
  content: string
  /** 通过 / 触发的 skill 名 */
  skill: string
}
interface AssistantBubbleContent {
  steps: AgentStep[]
  /** 该气泡对应的 run 正在进行中 */
  streaming: boolean
}

interface ChatPanelProps {
  messages: Message[]
  /** 当前会话中正在进行的 run;没有则为 null */
  streaming: Pick<StreamingRun, 'runId' | 'steps'> | null
  /** 草稿态:尚未创建会话,显示欢迎页 */
  isDraft: boolean
  sending: boolean
  /** 已配置的模型服务商(选择器按服务商分组) */
  providers: ModelProvider[]
  currentRef?: ModelRef
  /** skillName 为通过 / 选择的 skill,未选择时为 undefined */
  onSend: (content: string, skillName?: string) => void
  /** 用户点击停止按钮 */
  onCancel: () => void
  onModelChange: (ref: ModelRef) => void
  onOpenSettings: () => void
}

/** 一步是否还没有任何产出 */
const isEmptyStep = (s: AgentStep): boolean =>
  !s.content && !s.reasoning && s.toolCalls.length === 0

// 按消息 role 映射气泡样式;自定义角色名 'assistant' 直接作为 key
const roles: BubbleListProps['role'] = {
  user: {
    placement: 'end',
    shape: 'corner',
    avatar: <Avatar icon={<UserOutlined />} />,
    contentRender: (msg: UserBubbleContent) => (
      <>
        {!!msg.skill && (
          <Tag icon={<ThunderboltOutlined />} color="geekblue" style={{ marginBottom: 4 }}>
            {msg.skill}
          </Tag>
        )}
        <XMarkdown content={msg.content} />
      </>
    )
  },
  assistant: {
    placement: 'start',
    variant: 'outlined',
    avatar: <Avatar icon={<RobotOutlined />} />,
    contentRender: (msg: AssistantBubbleContent) => (
      <AgentSteps steps={msg.steps} streaming={msg.streaming} />
    )
  }
}

/** 一个气泡分组:user 行自成一组,同一 run 的 assistant / tool 行合并成助手组 */
interface MessageGroup {
  key: string
  runId: string
  steps: AgentStep[]
  role: 'user' | 'assistant'
  skill: string
}

/** 库内一行 → Agent 的一步;落库的调用没有独立状态,先标为未完成 */
function toAgentStep(m: Message): AgentStep {
  return {
    messageId: m.id,
    content: m.content,
    reasoning: m.reasoning,
    toolCalls: m.tool_calls.map((c) => ({ ...c, status: 'running' as const }))
  }
}

/** 在全部已分组的结果里递归查找某个工具调用;子 Agent 的行据此挂载 */
function findCallInGroups(groups: MessageGroup[], callId: string): StreamingToolCall | undefined {
  for (const group of groups) {
    const hit = findCall(group.steps, callId)
    if (hit) return hit
  }
  return undefined
}

/**
 * 把库里按协议逐条存放的消息合并成气泡项:
 * user 行单独一个气泡;同一 run 内的 assistant / tool 行合并成一个助手气泡,
 * tool 行的结果挂到对应的工具调用上;
 * 子 Agent 的行挂在发起它的那次 task 调用下面,不参与顶层分组。
 */
function groupMessages(messages: Message[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  let current: MessageGroup | null = null

  for (const m of messages) {
    // 子 Agent 的行:找到承载它的 task 调用,往那个调用的 agentSteps 里塞
    if (m.parent_call_id) {
      const host = findCallInGroups(groups, m.parent_call_id)
      // 父级行缺失(会话数据被改坏)时跳过,不影响其余内容展示
      if (!host) continue
      // 角色名落在每一行上,据此恢复标注(通用角色为空串)
      if (m.agent) host.agentName = m.agent
      const nested = (host.agentSteps ??= [])
      if (m.role === 'assistant') nested.push(toAgentStep(m))
      else if (m.role === 'tool') attachToolResult(nested, m.tool_call_id, m.content)
      continue
    }

    if (m.role === 'user' || m.role === 'system') {
      groups.push({
        key: m.id,
        runId: '',
        role: 'user',
        skill: m.skill,
        steps: [{ messageId: m.id, content: m.content, reasoning: '', toolCalls: [] }]
      })
      current = null
      continue
    }
    // 没有 run_id 的旧数据:每条 assistant 自成一组
    const sameRun = current !== null && m.run_id !== '' && current.runId === m.run_id
    if (current === null || !sameRun) {
      current = { key: m.run_id || m.id, runId: m.run_id, role: 'assistant', skill: '', steps: [] }
      groups.push(current)
    }
    if (m.role === 'assistant') {
      current.steps.push(toAgentStep(m))
    } else {
      attachToolResult(current.steps, m.tool_call_id, m.content)
    }
  }

  return groups.map(({ key, runId, steps, role, skill }) => ({
    key,
    runId,
    role,
    skill,
    steps: role === 'user' ? steps : steps.map(finalizeStep)
  }))
}

function ChatPanel({
  messages,
  streaming,
  isDraft,
  sending,
  providers,
  currentRef,
  onSend,
  onCancel,
  onModelChange,
  onOpenSettings
}: ChatPanelProps): React.JSX.Element {
  const { token } = theme.useToken()
  const [value, setValue] = useState('')
  // 通过 / 选中的 skill,发送后清空
  const [activeSkill, setActiveSkill] = useState<string | null>(null)
  const skills = useSkills()
  const enabledSkills = skills.filter((s) => s.enabled && !s.error)
  // 没有模型的服务商不参与选择,否则会多出一个空的分组标题
  const selectable = providers.filter((p) => p.models.length > 0)

  const userIds = new Set(messages.filter((m) => m.role === 'user').map((m) => m.id))
  const items: BubbleListProps['items'] = groupMessages(messages).map((g) => {
    if (userIds.has(g.key)) {
      return {
        key: g.key,
        role: 'user',
        content: { content: g.steps[0].content, skill: g.skill } as UserBubbleContent
      }
    }
    // 进行中的 run 以流式状态为准,比落库数据更新
    const isStreaming = streaming !== null && streaming.runId === g.runId
    const steps = isStreaming ? streaming.steps : g.steps
    return {
      key: g.key,
      role: 'assistant',
      content: { steps, streaming: isStreaming } as AssistantBubbleContent,
      loading: isStreaming && steps.every(isEmptyStep),
      streaming: isStreaming
    }
  })
  // run 刚开始、消息列表尚未包含其占位行时,补一条合成项
  if (streaming && !items.some((it) => it.key === streaming.runId)) {
    items.push({
      key: streaming.runId,
      role: 'assistant',
      content: { steps: streaming.steps, streaming: true } as AssistantBubbleContent,
      loading: streaming.steps.every(isEmptyStep),
      streaming: true
    })
  }

  const handleSubmit = (text: string): void => {
    onSend(text, activeSkill ?? undefined)
    // Sender 的 onSubmit 不会清空输入框,需要手动重置受控值
    setValue('')
    setActiveSkill(null)
  }

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', padding: token.padding }}>
        {isDraft ? (
          <div style={{ margin: 'auto', width: '100%', maxWidth: 720 }}>
            <Welcome
              variant="borderless"
              icon={<Avatar size={48} icon={<RobotOutlined />} />}
              title="你好,我是 CyberTiger"
              description="在下方输入消息,开始一段新的对话。"
            />
          </div>
        ) : (
          <Bubble.List style={{ height: '100%' }} items={items} role={roles} autoScroll />
        )}
      </div>
      <div style={{ padding: `0 ${token.padding}px ${token.padding}px` }}>
        {/* 输入 / 时弹出 skill 列表;选中后作为标签显示在输入框内 */}
        <Suggestion
          block
          // 弹层根挂自定义类,配合 main.css 把确定宽度链式传给内层(见 CSS 注释)
          classNames={{ popup: 'cybertiger-skill-dropdown' }}
          // cascader 默认给弹层 minWidth:'auto'(内容驱动),覆盖 stretch 算出的触发元素宽度;
          // 重置为 0 让弹层宽度跟随输入框,随窗口自适应
          popupStyle={{ minWidth: 0 }}
          items={enabledSkills.map((s) => ({
            value: s.name,
            // 名称：描述 融合为单个 label 项,配合 flex:1 + ellipsis 铺满弹层宽度
            label: (
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {s.name}
                {s.description ? `：${s.description}` : ''}
              </span>
            ),
            icon: <ThunderboltOutlined />
          }))}
          onSelect={(name) => {
            setActiveSkill(name)
            setValue('')
            // 选择后自动聚焦输入框,便于直接输入参数;此时组件已切到 slot 模式(contenteditable)
            requestAnimationFrame(() => {
              const ed = document.querySelector<HTMLElement>('.ant-sender-input-slot')
              if (ed) {
                ed.focus()
                const sel = window.getSelection()
                if (sel) {
                  const range = document.createRange()
                  range.selectNodeContents(ed)
                  range.collapse(false)
                  sel.removeAllRanges()
                  sel.addRange(range)
                }
              }
            })
          }}
        >
          {({ onTrigger, onKeyDown }) => (
            <Sender
              value={value}
              onChange={(next, _event, _slotConfig, skill) => {
                setValue(next)
                // 键盘 Backspace 删 skill 标签只清 DOM,不会触发 closable.onClose;
                // 此时 onChange 的 skill 参数为 undefined,据此同步清掉选中状态,避免输入时回填
                if (!skill && activeSkill) {
                  setActiveSkill(null)
                  // 删除后组件从 slot 模式切回普通输入框,组件库不恢复焦点;
                  // 等 React 提交完成后再把焦点放回输入框末尾
                  requestAnimationFrame(() => {
                    const el = document.querySelector<HTMLTextAreaElement>('.ant-sender textarea')
                    if (el) {
                      el.focus()
                      el.setSelectionRange(el.value.length, el.value.length)
                    }
                  })
                }
                // 只在输入框内容恰好是 "/" 开头且不含空格时弹出,避免正文里的斜杠误触发
                if (next.startsWith('/') && !next.includes(' ') && enabledSkills.length > 0) {
                  onTrigger()
                } else {
                  onTrigger(false)
                }
              }}
              onKeyDown={onKeyDown}
              onSubmit={handleSubmit}
              // loading 时发送按钮变为停止按钮,点击触发 onCancel
              loading={sending}
              onCancel={onCancel}
              skill={
                activeSkill
                  ? {
                      value: activeSkill,
                      title: activeSkill,
                      closable: { onClose: () => setActiveSkill(null) }
                    }
                  : undefined
              }
              placeholder={
                enabledSkills.length > 0
                  ? '输入消息,Enter 发送,Shift + Enter 换行,/ 选择 skill'
                  : '输入消息,Enter 发送,Shift + Enter 换行'
              }
              autoSize={{ minRows: 1, maxRows: 6 }}
              // 发送按钮移到底栏,与模型选择器同一行
              suffix={false}
              footer={(actions) => (
                <Flex justify="space-between" align="center">
                  {selectable.length > 0 ? (
                    <Select<string>
                      size="small"
                      variant="borderless"
                      value={currentRef ? modelKey(currentRef) : undefined}
                      placeholder="选择模型"
                      // 按服务商分组;同名模型分属不同服务商时靠分组标题区分
                      options={selectable.map((p) => ({
                        label: p.name,
                        options: p.models.map((model) => ({
                          value: modelKey({ providerId: p.id, model }),
                          label: model
                        }))
                      }))}
                      onChange={(key) => onModelChange(parseModelKey(key))}
                      // 收起时补上服务商名,否则只看到一个 model id 分不清是哪家
                      labelRender={({ value }) => {
                        const ref = value === undefined ? undefined : parseModelKey(String(value))
                        const provider = providers.find((p) => p.id === ref?.providerId)
                        return provider && ref ? `${provider.name} · ${ref.model}` : String(value)
                      }}
                      // 回复途中不允许切模型
                      disabled={sending}
                      popupMatchSelectWidth={false}
                      style={{ minWidth: 160 }}
                    />
                  ) : (
                    <Button
                      type="link"
                      size="small"
                      icon={<SettingOutlined />}
                      onClick={onOpenSettings}
                    >
                      去设置里添加模型
                    </Button>
                  )}
                  {actions}
                </Flex>
              )}
            />
          )}
        </Suggestion>
      </div>
    </div>
  )
}

export default ChatPanel
