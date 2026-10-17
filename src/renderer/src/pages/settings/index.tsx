import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Button, Tabs, theme } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import type { AppearanceSettings } from '../../../../main/store/types'
import ProvidersPanel from './ProvidersPanel'
import AppearancePanel from './AppearancePanel'
import McpConfigEditor from './McpConfigEditor'
import SkillsPanel from './SkillsPanel'
import AgentsPanel from './AgentsPanel'

interface SettingsPageProps {
  appearance: AppearanceSettings
  onAppearanceChange: (next: AppearanceSettings) => void
}

/**
 * 设置页:按域拆成多个 tab。
 * 原先四个分区竖着堆在一屏里,内容一多就得一直往下滚,也看不出有几个配置域。
 * 默认停在"模型服务"——未配置 Base URL 时会被自动带到这个页面,这里是最该先填的。
 */
function SettingsPage({ appearance, onAppearanceChange }: SettingsPageProps): React.JSX.Element {
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const [activeKey, setActiveKey] = useState('model')

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
