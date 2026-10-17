import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { Button, Tabs, theme } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import type { AppearanceSettings, PermissionSettings } from '../../../../main/store/types'
import ProvidersPanel from './ProvidersPanel'
import AppearancePanel from './AppearancePanel'
import PermissionPanel from './PermissionPanel'
import McpConfigEditor from './McpConfigEditor'
import SkillsPanel from './SkillsPanel'
import AgentsPanel from './AgentsPanel'

interface SettingsPageProps {
  appearance: AppearanceSettings
  onAppearanceChange: (next: AppearanceSettings) => void
  permissions: PermissionSettings
  onPermissionsChange: (next: PermissionSettings) => void
}

/** 全部 tab 的 key:`?tab=xxx` 深链只认这些值,认不出的一律退回默认那档 */
const TAB_KEYS = ['model', 'appearance', 'permission', 'mcp', 'skills', 'agents']

/**
 * 初始停在哪个 tab。
 *
 * 默认是「模型服务」(未配置 Base URL 时会被自动带到这里,那是最该先填的);
 * 审批卡片上那颗「加入白名单」带 `?tab=permission` 过来,不然用户点完还得自己找那一栏。
 */
function initialTab(search: string): string {
  const tab = new URLSearchParams(search).get('tab')
  return tab && TAB_KEYS.includes(tab) ? tab : 'model'
}

/**
 * 设置页:按域拆成多个 tab。
 * 原先四个分区竖着堆在一屏里,内容一多就得一直往下滚,也看不出有几个配置域。
 */
function SettingsPage({
  appearance,
  onAppearanceChange,
  permissions,
  onPermissionsChange
}: SettingsPageProps): React.JSX.Element {
  const navigate = useNavigate()
  const { search } = useLocation()
  const { token } = theme.useToken()
  const [activeKey, setActiveKey] = useState(() => initialTab(search))

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: token.colorBgLayout
      }}
    >
      {/* 无边框顶栏:设置页也要这条带,否则「返回对话」按钮正压在红绿灯的位置上 */}
      <div className="cybertiger-titlebar-drag" />
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <div style={{ maxWidth: 880, margin: '0 auto', padding: token.paddingLG }}>
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate('/')}
            style={{ marginBottom: token.marginXS }}
          >
            返回对话
          </Button>

          <Tabs
            activeKey={activeKey}
            onChange={setActiveKey}
            items={[
              { key: 'model', label: '模型服务', children: <ProvidersPanel /> },
              {
                key: 'appearance',
                label: '外观',
                children: <AppearancePanel appearance={appearance} onChange={onAppearanceChange} />
              },
              {
                key: 'permission',
                label: '权限',
                children: (
                  <PermissionPanel permissions={permissions} onChange={onPermissionsChange} />
                )
              },
              { key: 'mcp', label: 'MCP 服务', children: <McpConfigEditor /> },
              { key: 'skills', label: 'Skills', children: <SkillsPanel /> },
              { key: 'agents', label: '子 Agent', children: <AgentsPanel /> }
            ]}
            // 分区内容可能很长,滚动时让 tab 栏留在视野内
            tabBarStyle={{
              position: 'sticky',
              top: 0,
              zIndex: 1,
              background: token.colorBgLayout
            }}
          />
        </div>
      </div>
    </div>
  )
}

export default SettingsPage
