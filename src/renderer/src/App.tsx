import { HashRouter, useLocation } from 'react-router'
import { App as AntdApp, theme } from 'antd'
import { XProvider } from '@ant-design/x'
import antdZhCN from 'antd/locale/zh_CN'
import xZhCN from '@ant-design/x/locale/zh_CN'
import { useSystemTheme } from './hooks/useSystemTheme'
import ChatPage from './pages/chat'
import SettingsPage from './pages/settings'

/**
 * 聊天页始终挂载:它持有会话、流式状态和发送标志,卸载会丢失进行中的回复。
 * 进入设置页时只是把聊天页隐藏。
 */
function Routes(): React.JSX.Element {
  const { pathname } = useLocation()
  const onSettings = pathname === '/settings'
  return (
    <>
      <div style={{ height: '100%', display: onSettings ? 'none' : undefined }}>
        <ChatPage />
      </div>
      {onSettings && <SettingsPage />}
    </>
  )
}

function App(): React.JSX.Element {
  const isDark = useSystemTheme()

  return (
    <XProvider
      locale={{ ...antdZhCN, ...xZhCN }}
      theme={{ algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm }}
    >
      <AntdApp style={{ height: '100%' }}>
        <HashRouter>
          <Routes />
        </HashRouter>
      </AntdApp>
    </XProvider>
  )
}

export default App
