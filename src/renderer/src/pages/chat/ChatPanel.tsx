import { useState } from 'react'
import { Bubble, Sender, Welcome } from '@ant-design/x'
import type { BubbleListProps } from '@ant-design/x'
import XMarkdown from '@ant-design/x-markdown'
import { Avatar, Button, Flex, Select, theme } from 'antd'
import { RobotOutlined, SettingOutlined, UserOutlined } from '@ant-design/icons'
import type { Message } from '../../../../main/chat/sql'
import type { StreamingReply } from '../../hooks/useReplyStream'

interface ChatPanelProps {
  messages: Message[]
  /** 当前会话中正在流式生成的回复;没有则为 null */
  streaming: Pick<StreamingReply, 'messageId' | 'content'> | null
  /** 草稿态:尚未创建会话,显示欢迎页 */
  isDraft: boolean
  sending: boolean
  /** 设置里配置的模型 ID 列表 */
  models: string[]
  currentModel?: string
  onSend: (content: string) => void
  /** 用户点击停止按钮 */
  onCancel: () => void
  onModelChange: (model: string) => void
  onOpenSettings: () => void
}

// 按消息 role 映射气泡样式;自定义角色名 'assistant' 直接作为 key
const roles: BubbleListProps['role'] = {
  user: {
    placement: 'end',
    shape: 'corner',
    avatar: <Avatar icon={<UserOutlined />} />
  },
  assistant: {
    placement: 'start',
    variant: 'outlined',
    avatar: <Avatar icon={<RobotOutlined />} />,
    // 助手回复按 Markdown 渲染;用户消息保持纯文本
    contentRender: (content: string) => <XMarkdown content={content} />
  }
}

function ChatPanel({
  messages,
  streaming,
  isDraft,
  sending,
  models,
  currentModel,
  onSend,
  onCancel,
  onModelChange,
  onOpenSettings
}: ChatPanelProps): React.JSX.Element {
  const { token } = theme.useToken()
  const [value, setValue] = useState('')

  const items: BubbleListProps['items'] = messages.map((m) => {
    const isStreaming = streaming?.messageId === m.id
    return {
      key: m.id,
      role: m.role,
      content: isStreaming ? streaming.content : m.content,
      loading: isStreaming && streaming.content === '',
      streaming: isStreaming
    }
  })
  // 生成刚开始、消息列表尚未包含占位行时,补一条合成项
  if (streaming && !messages.some((m) => m.id === streaming.messageId)) {
    items.push({
      key: streaming.messageId,
      role: 'assistant',
      content: streaming.content,
      loading: streaming.content === '',
      streaming: true
    })
  }

  const handleSubmit = (text: string): void => {
    onSend(text)
    // Sender 的 onSubmit 不会清空输入框,需要手动重置受控值
    setValue('')
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
        <Sender
          value={value}
          onChange={(next) => setValue(next)}
          onSubmit={handleSubmit}
          // loading 时发送按钮变为停止按钮,点击触发 onCancel
          loading={sending}
          onCancel={onCancel}
          placeholder="输入消息,Enter 发送,Shift + Enter 换行"
          autoSize={{ minRows: 1, maxRows: 6 }}
          // 发送按钮移到底栏,与模型选择器同一行
          suffix={false}
          footer={(actions) => (
            <Flex justify="space-between" align="center">
              {models.length > 0 ? (
                <Select<string>
                  size="small"
                  variant="borderless"
                  value={currentModel}
                  placeholder="选择模型"
                  options={models.map((m) => ({ value: m, label: m }))}
                  onChange={onModelChange}
                  // 回复途中不允许切模型
                  disabled={sending}
                  popupMatchSelectWidth={false}
                  style={{ minWidth: 140 }}
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
      </div>
    </div>
  )
}

export default ChatPanel
