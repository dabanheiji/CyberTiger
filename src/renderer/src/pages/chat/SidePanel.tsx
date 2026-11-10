import { Button, Tabs, Tooltip, theme } from 'antd'
import { CloseOutlined } from '@ant-design/icons'
import ErrorBoundary from '../../components/ErrorBoundary'
import TerminalView from './TerminalView'

interface SidePanelProps {
  conversationId: string | null
  workspace: string
  onClose: () => void
}

/**
 * 右侧浮层侧边栏。本期只有一个「终端」tab,结构上按多 tab 容器搭 ——
 * 以后加 tab 只在 items 里加一项,终端会话本身已在主进程按工作目录复用。
 *
 * 绝对定位而不挤压聊天列:底栏那排控件(工作空间 / 档位 / 模型 / 占用环)在 900px 窗口下
 * 仍然放得下。面板自己铺一条顶栏拖拽带,开着面板时窗口照样能拖;win/linux 的系统按钮
 * 压在那条空白带上,tab 栏从 38px 以下开始,不会被盖住。
 */
function SidePanel({ conversationId, workspace, onClose }: SidePanelProps): React.JSX.Element {
  const { token } = theme.useToken()

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 'clamp(320px, 42vw, 460px)',
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        background: token.colorBgContainer,
        borderLeft: `1px solid ${token.colorBorderSecondary}`,
        boxShadow: token.boxShadowSecondary
      }}
    >
      <div className="cybertiger-titlebar-drag" />
      <ErrorBoundary title="终端面板渲染出错">
        <Tabs
          type="editable-card"
          hideAdd
          activeKey="terminal"
          items={[
            {
              key: 'terminal',
              label: '终端',
              closable: false,
              children: <TerminalView conversationId={conversationId} workspace={workspace} />
            }
          ]}
          tabBarExtraContent={
            <Tooltip title="关闭侧边栏">
              <Button
                type="text"
                size="small"
                aria-label="关闭侧边栏"
                icon={<CloseOutlined />}
                onClick={onClose}
              />
            </Tooltip>
          }
          style={{ flex: 1, minHeight: 0 }}
          styles={{
            root: { height: '100%', display: 'flex', flexDirection: 'column' },
            body: { flex: 1, minHeight: 0 },
            content: { height: '100%' }
          }}
        />
      </ErrorBoundary>
    </div>
  )
}

export default SidePanel
