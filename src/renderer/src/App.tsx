import { App as AntdApp, theme } from 'antd'
import { XProvider } from '@ant-design/x'
import antdZhCN from 'antd/locale/zh_CN'
import xZhCN from '@ant-design/x/locale/zh_CN'
import { useSystemTheme } from './hooks/useSystemTheme'
import ChatPage from './pages/chat'

function App(): React.JSX.Element {
  const isDark = useSystemTheme()

  return (
    <XProvider
      locale={{ ...antdZhCN, ...xZhCN }}
      theme={{ algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm }}
    >
      <AntdApp style={{ height: '100%' }}>
        <ChatPage />
      </AntdApp>
    </XProvider>
  )
}

export default App
