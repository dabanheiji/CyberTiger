import { useState } from 'react'
import { Conversations } from '@ant-design/x'
import type { ConversationsProps } from '@ant-design/x'
import { Button, Input, Modal, Tooltip, theme } from 'antd'
import {
  DeleteOutlined,
  EditOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  PlusOutlined,
  SettingOutlined
} from '@ant-design/icons'
import type { Conversation } from '../../../../main/chat/sql'
import { workspaceGroupDir, workspaceGroupKey, workspaceLabel } from '../../lib/workspace'

interface SidebarProps {
  conversations: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  /** 组标题上的「+」:在该组的工作空间下新开会话,空串即不带工作空间 */
  onNewInWorkspace: (dir: string) => void
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
  onNewInWorkspace,
  onRename,
  onDelete,
  onOpenSettings
}: SidebarProps): React.JSX.Element {
  const { token } = theme.useToken()
  const [renaming, setRenaming] = useState<RenamingState | null>(null)
  /**
   * 收起着哪些组。存「收起的」而不是「展开的」是因为组件的 defaultExpandedKeys 是空
   * 数组＝全收起,按展开清单初始化就得每次重算,而新出现的组要默认展开。
   */
  const [collapsed, setCollapsed] = useState<string[]>([])

  const items: ConversationsProps['items'] = conversations.map((c) => ({
    key: c.id,
    label: c.title,
    group: workspaceGroupKey(c.workspace)
  }))
  // 组的先后由每组最新那条会话的位置决定:会话本身按更新时间倒序,所以不用另外排序
  const groupKeys = [...new Set(conversations.map((c) => workspaceGroupKey(c.workspace)))]
  const expandedKeys = groupKeys.filter((key) => !collapsed.includes(key))

  /** 组标题:文件夹图标(开合=折叠状态) + 末段目录名(整串放 Tooltip) + 右对齐的「+」 */
  function renderGroupLabel(name: string): React.JSX.Element {
    const dir = workspaceGroupDir(name)
    const isCollapsed = collapsed.includes(name)
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: token.marginXXS, minWidth: 0 }}>
        {/* 组件自带的那个旋转箭头用 CSS 隐掉了,开合状态改由文件夹的打开 / 关闭表示 */}
        {isCollapsed ? <FolderOutlined /> : <FolderOpenOutlined />}
        <Tooltip title={dir || '未选择工作空间:文件与命令按应用当前目录处理'} placement="right">
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis'
            }}
          >
            {workspaceLabel(dir)}
          </span>
        </Tooltip>
        <Tooltip title={dir ? `在 ${dir} 下新建对话` : '新建不带工作空间的对话'} placement="right">
          <Button
            type="text"
            size="small"
            aria-label="在该分组新建对话"
            icon={<PlusOutlined />}
            onClick={(e) => {
              // 整行标题是折叠开关,点「+」不该顺手把组收起来
              e.stopPropagation()
              onNewInWorkspace(dir)
            }}
          />
        </Tooltip>
      </div>
    )
  }

  const groupable: ConversationsProps['groupable'] = {
    label: renderGroupLabel,
    collapsible: true,
    expandedKeys,
    onExpand: (keys): void => {
      setCollapsed(groupKeys.filter((key) => !keys.includes(key)))
    }
  }

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
        // 组标签要有 ellipsis 就得参与父级 flex 的宽度链,见 assets/main.css 的说明
        classNames={{ group: 'cybertiger-conversations-group' }}
        items={items}
        // 草稿态传空串而不是 undefined，否则组件会退化为非受控
        activeKey={activeId ?? ''}
        onActiveChange={onSelect}
        groupable={groupable}
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
