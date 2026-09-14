import { useState } from 'react'
import { Conversations } from '@ant-design/x'
import type { ConversationsProps } from '@ant-design/x'
import { Button, Input, Modal, Tooltip, theme } from 'antd'
import { DeleteOutlined, EditOutlined, SettingOutlined } from '@ant-design/icons'
import type { Conversation } from '../../../../main/chat/sql'

interface SidebarProps {
  conversations: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onOpenSettings: () => void
}

interface RenamingState {
  id: string
  title: string
}

function Sidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onOpenSettings
}: SidebarProps): React.JSX.Element {
  const { token } = theme.useToken()
  const [renaming, setRenaming] = useState<RenamingState | null>(null)

  const items: ConversationsProps['items'] = conversations.map((c) => ({
    key: c.id,
    label: c.title
  }))

  const menu: ConversationsProps['menu'] = (item) => ({
    items: [
      { key: 'rename', label: '重命名', icon: <EditOutlined /> },
      { key: 'delete', label: '删除', icon: <DeleteOutlined />, danger: true }
    ],
    onClick: ({ key }): void => {
      if (key === 'rename') {
        const current = conversations.find((c) => c.id === item.key)
        setRenaming({ id: item.key, title: current?.title ?? '' })
      } else if (key === 'delete') {
        onDelete(item.key)
      }
    }
  })

  const submitRename = (): void => {
    if (!renaming) return
    const title = renaming.title.trim()
    if (!title) return
    onRename(renaming.id, title)
    setRenaming(null)
  }

  return (
    <div
      style={{
        width: 260,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: token.colorBgContainer,
        borderRight: `1px solid ${token.colorBorderSecondary}`
      }}
    >
      <Conversations
        style={{ flex: 1, minHeight: 0 }}
        items={items}
        // 草稿态传空串而不是 undefined，否则组件会退化为非受控
        activeKey={activeId ?? ''}
        onActiveChange={onSelect}
        creation={{ onClick: onNew }}
        menu={menu}
      />
      <div
        style={{
          padding: token.paddingXS,
          borderTop: `1px solid ${token.colorBorderSecondary}`
        }}
      >
        <Tooltip title="设置" placement="right">
          <Button
            type="text"
            aria-label="设置"
            icon={<SettingOutlined />}
            onClick={onOpenSettings}
          />
        </Tooltip>
      </div>
      <Modal
        title="重命名对话"
        open={renaming !== null}
        okText="确定"
        cancelText="取消"
        okButtonProps={{ disabled: !renaming?.title.trim() }}
        onOk={submitRename}
        onCancel={() => setRenaming(null)}
        destroyOnHidden
      >
        <Input
          autoFocus
          maxLength={50}
          value={renaming?.title ?? ''}
          onChange={(e) =>
            setRenaming((prev) => (prev ? { ...prev, title: e.target.value } : prev))
          }
          onPressEnter={submitRename}
        />
      </Modal>
    </div>
  )
}

export default Sidebar
