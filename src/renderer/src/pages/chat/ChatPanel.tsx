import { useState } from 'react'
import { Bubble, Sender, Suggestion, Welcome } from '@ant-design/x'
import type { BubbleListProps } from '@ant-design/x'
import XMarkdown from '@ant-design/x-markdown'
import { Avatar, Button, Dropdown, Flex, Popover, Progress, Select, Space, Tag, theme } from 'antd'
import type { MenuProps } from 'antd'
import {
  FolderOpenOutlined,
  FolderOutlined,
  RobotOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  UserOutlined
} from '@ant-design/icons'
import type { Message } from '../../../../main/chat/sql'
import type { ModelProvider, ModelRef } from '../../../../main/store/types'
import { contextWindowOf } from '../../../../main/store/modelRef'
import { budgetFor } from '../../../../main/agent/context'
import { formatTokens } from '../../../../main/tokens/estimate'
import { modelKey, parseModelKey } from '../../lib/modelRef'
import { workspaceLabel } from '../../lib/workspace'
import { contextUsage, usageLevel, type ContextUsage } from '../../lib/contextUsage'
import type {
  AgentStep,
  PendingQuestion,
  StreamingRun,
  StreamingToolCall
} from '../../hooks/useAgentStream'
import { attachToolResult, finalizeStep, findCall, toStepUsage } from '../../lib/agentSteps'
import { useSkills } from '../../hooks/useSkills'
import AgentSteps from '../../components/AgentSteps'
import AskUserCard from '../../components/AskUserCard'

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
  /**
   * 用来把「本条回复的上下文占用」换算成百分比的窗口。
   * 库里的行没记录当时用的是哪个模型,所以按当前所选模型的窗口算 ——
   * 中途换过模型的老气泡会因此偏差,进度条才是当前会话的权威读数。
   */
  contextWindow?: number
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
  /** 手动压缩在等 IPC 返回 */
  compacting: boolean
  /** 当前会话的工作空间目录;空串表示未选(工具按应用当前目录执行) */
  workspace: string
  /** 最近用过的工作空间,最新在前 */
  recentWorkspaces: string[]
  /** 模型正等着用户回答的那次提问;run 就阻塞在这一轮的那次工具调用上 */
  pendingQuestion: PendingQuestion | null
  /** skillName 为通过 / 选择的 skill,未选择时为 undefined */
  onSend: (content: string, skillName?: string) => void
  /** 用户点击停止按钮 */
  onCancel: () => void
  /** 用户提交选择(或跳过,此时是空数组) */
  onAnswerQuestion: (answers: string[]) => void
  /** 占用环里那颗「立即压缩上下文」 */
  onCompact: () => void
  onModelChange: (ref: ModelRef) => void
  onOpenSettings: () => void
  /** 点「选择文件夹…」:由父层弹系统对话框 */
  onPickWorkspace: () => void
  /** 从下拉里选一个目录(含最近使用) */
  onSelectWorkspace: (dir: string) => void
  /** 清除当前工作空间 */
  onClearWorkspace: () => void
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
      <AgentSteps steps={msg.steps} streaming={msg.streaming} contextWindow={msg.contextWindow} />
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
    // 用量随每一行入库,历史回放才能显示和历史一致,而不是只有实时流有
    usage: toStepUsage(m),
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

interface ContextRingProps {
  usage: ContextUsage
  /** 这一轮还在跑:主进程不允许压缩与 run 并发(两边会互相踩水位),按钮只能等着 */
  busy: boolean
  /** 手动压缩正在等 IPC 返回 */
  compacting: boolean
  onCompact: () => void
}

/**
 * 输入框底栏的上下文占用环。
 * 满刻度是当前模型的窗口,环上不写数字(底栏太挤),Popover 里只报「已用 / 窗口 / 百分比」
 * 加那颗手动压缩按钮 —— 压缩的账目与失败原因由聊天页的 message 提示说给用户,不堆在环上。
 * 用 Popover 而不是 Tooltip:里面的按钮要能点。
 */
function ContextRing({ usage, busy, compacting, onCompact }: ContextRingProps): React.JSX.Element {
  const { token } = theme.useToken()
  const level = usageLevel(usage)
  const color =
    level === 'danger'
      ? token.colorError
      : level === 'warning'
        ? token.colorWarning
        : token.colorPrimary
  const percent = Math.round(usage.ratio * 100)

  return (
    <Popover
      trigger="click"
      title={`已用 ${formatTokens(usage.used)}${usage.estimated ? '(估算)' : ''} / 窗口 ${formatTokens(usage.window)}(${percent}%)`}
      content={
        <Button
          size="small"
          type="primary"
          loading={compacting}
          disabled={busy}
          onClick={onCompact}
        >
          立即压缩上下文
        </Button>
      }
    >
      <Progress
        type="circle"
        percent={percent}
        showInfo={false}
        size={16}
        strokeColor={color}
        // 根节点默认是 inline-flex,会跟同行高(22px)的基线排版,环被顶离垂直中线;
        // 改成块级 flex 后条目高度就是环本身,Space 的 align="center" 才能对齐下拉框。
        // 描边宽度不写:antd 对小圆环按「不小于 3px」自动算,比固定百分比更稳。
        styles={{ root: { display: 'flex' } }}
      />
    </Popover>
  )
}

interface WorkspacePickerProps {
  workspace: string
  recent: string[]
  disabled: boolean
  onPick: () => void
  onSelect: (dir: string) => void
  onClear: () => void
}

/** 下拉里两个非目录项的 key:真实目录都是绝对路径,不会与这两个串撞车 */
const PICK_KEY = '__pick__'
const CLEAR_KEY = '__clear__'

/**
 * 底栏的工作空间选择器:一眼看到当前会话在哪个目录里干活,点击即可换。
 *
 * 完整路径放在下拉的第一行(禁用项)而不是 Tooltip 里:Tooltip 与 Dropdown 套同一个子元素
 * 要操心 ref 转发,而下拉本来就要打开,顺手把全路径写在那儿更省事。
 */
function WorkspacePicker({
  workspace,
  recent,
  disabled,
  onPick,
  onSelect,
  onClear
}: WorkspacePickerProps): React.JSX.Element {
  const items: NonNullable<MenuProps['items']> = [
    {
      key: '__current__',
      disabled: true,
      label: workspace || '未选择:文件与命令按应用当前目录执行'
    },
    { type: 'divider' },
    { key: PICK_KEY, icon: <FolderOpenOutlined />, label: '选择文件夹…' }
  ]
  // 当前目录不再重复出现在最近列表里(它已经写在第一行)
  const shown = recent.filter((dir) => dir && dir !== workspace).slice(0, 5)
  if (shown.length > 0) {
    items.push({ type: 'divider' })
    for (const dir of shown) items.push({ key: dir, icon: <FolderOutlined />, label: dir })
  }
  if (workspace) {
    items.push({ type: 'divider' })
    items.push({ key: CLEAR_KEY, label: '清除工作空间' })
  }

  return (
    <Dropdown
      trigger={['click']}
      disabled={disabled}
      menu={{
        items,
        onClick: ({ key }) => {
          if (key === PICK_KEY) onPick()
          else if (key === CLEAR_KEY) onClear()
          else onSelect(key)
        }
      }}
    >
      <Button size="small" type="text" icon={<FolderOutlined />} disabled={disabled}>
        {/* 长目录名会把底栏挤变形,超出宽度只留末段并截断 */}
        <span
          style={{
            maxWidth: 140,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            verticalAlign: 'bottom'
          }}
        >
          {workspaceLabel(workspace)}
        </span>
      </Button>
    </Dropdown>
  )
}

function ChatPanel({
  messages,
  streaming,
  isDraft,
  sending,
  providers,
  currentRef,
  compacting,
  workspace,
  recentWorkspaces,
  pendingQuestion,
  onSend,
  onCancel,
  onAnswerQuestion,
  onCompact,
  onModelChange,
  onOpenSettings,
  onPickWorkspace,
  onSelectWorkspace,
  onClearWorkspace
}: ChatPanelProps): React.JSX.Element {
  const { token } = theme.useToken()
  const [value, setValue] = useState('')
  // 通过 / 选中的 skill,发送后清空
  const [activeSkill, setActiveSkill] = useState<string | null>(null)
  const skills = useSkills()
  const enabledSkills = skills.filter((s) => s.enabled && !s.error)
  // 没有模型的服务商不参与选择,否则会多出一个空的分组标题
  const selectable = providers.filter((p) => p.models.length > 0)
  // 窗口跟着当前选择走;气泡底部的百分比和进度条共用同一个数,两处不会各说一套
  const contextWindow = currentRef
    ? budgetFor(
        contextWindowOf(
          providers.find((p) => p.id === currentRef.providerId),
          currentRef.model
        )
      ).window
    : undefined
  const usage = contextUsage({
    streamingSteps: streaming?.steps,
    messages,
    providers,
    currentRef
  })

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
      content: { steps, streaming: isStreaming, contextWindow } as AssistantBubbleContent,
      loading: isStreaming && steps.every(isEmptyStep),
      streaming: isStreaming
    }
  })
  // run 刚开始、消息列表尚未包含其占位行时,补一条合成项
  if (streaming && !items.some((it) => it.key === streaming.runId)) {
    items.push({
      key: streaming.runId,
      role: 'assistant',
      content: { steps: streaming.steps, streaming: true, contextWindow } as AssistantBubbleContent,
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
        {/* 提问卡片压住输入区:这一轮本来就停在等用户的选择 */}
        {pendingQuestion && (
          <AskUserCard
            key={pendingQuestion.questionId}
            question={pendingQuestion.question}
            options={pendingQuestion.options}
            multiSelect={pendingQuestion.multiSelect}
            onAnswer={onAnswerQuestion}
          />
        )}
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
                  <Space align="center" size={8}>
                    <WorkspacePicker
                      workspace={workspace}
                      recent={recentWorkspaces}
                      // 与主进程的守卫一致:一个 run 的目录在 startRun 就固定,跑途中不让换
                      disabled={sending}
                      onPick={onPickWorkspace}
                      onSelect={onSelectWorkspace}
                      onClear={onClearWorkspace}
                    />
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
                            value: modelKey({ providerId: p.id, model: model.name }),
                            label: model.name
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
                    {usage && (
                      <ContextRing
                        usage={usage}
                        busy={sending}
                        compacting={compacting}
                        onCompact={onCompact}
                      />
                    )}
                  </Space>
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
