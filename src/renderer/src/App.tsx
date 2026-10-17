import { useEffect, useMemo, useState } from 'react'
import { HashRouter, useLocation } from 'react-router'
import { App as AntdApp } from 'antd'
import { XProvider } from '@ant-design/x'
import antdZhCN from 'antd/locale/zh_CN'
import xZhCN from '@ant-design/x/locale/zh_CN'
import type { AppearanceSettings } from '../../main/store/types'
import { useSystemTheme } from './hooks/useSystemTheme'
import { buildTheme, defaultAccent, focusRing, selectionTint } from './theme'
import ChatPage from './pages/chat'
import SettingsPage from './pages/settings'

/**
 * 聊天页始终挂载:它持有会话、流式状态和发送标志,卸载会丢失进行中的回复。
 * 进入设置页时只是把聊天页隐藏。
 *
 * 外观设置只在这条链上传递(App → 设置页 → 外观面板),消费方只有强调色一处,
 * 所以不建 Context,也不新加一条 settings 推事件 —— `settings:*` 本来就是 pull-only。
 */
function Routes(props: {
  appearance: AppearanceSettings
  onAppearanceChange: (next: AppearanceSettings) => void
}): React.JSX.Element {
  const { pathname } = useLocation()
  const onSettings = pathname === '/settings'
  return (
    <>
      <div style={{ height: '100%', display: onSettings ? 'none' : undefined }}>
        <ChatPage />
      </div>
      {onSettings && <SettingsPage {...props} />}
    </>
  )
}

function App(): React.JSX.Element {
  const isDark = useSystemTheme()
  const [appearance, setAppearance] = useState<AppearanceSettings>({})

  // 只在挂载时读一次:明暗模式由主进程落到 nativeTheme,渲染层跟着 media query 走,
  // 这里要的只是用户自定义的强调色
  useEffect(() => {
    void (async (): Promise<void> => {
      setAppearance((await window.api.settings.get('appearance')) ?? {})
    })()
  }, [])

  // 没自定义过就用品牌色那一对(浅虎橙 / 暗琥珀);自定义过则把同一个颜色交给
  // deriveAccent 按模式钳明度,于是选了什么色相就一直是那个色相
  const accent = appearance.accent ?? defaultAccent(isDark)
  const themeConfig = useMemo(() => buildTheme(isDark, accent), [isDark, accent])

  // 选区底色与键盘焦点环写在 main.css 里,拿不到 antd 的 token,只能由这里注入变量;
  // CSS 那边同值留了一份兜底,首帧(JS 还没跑)不至于没有颜色
  useEffect(() => {
    const style = document.documentElement.style
    style.setProperty('--cybertiger-accent-selection', selectionTint(accent, isDark))
    style.setProperty('--cybertiger-accent-focus', focusRing(accent, isDark))
  }, [isDark, accent])

  return (
    <XProvider locale={{ ...antdZhCN, ...xZhCN }} theme={themeConfig}>
      <AntdApp style={{ height: '100%' }}>
        <HashRouter>
          <Routes appearance={appearance} onAppearanceChange={setAppearance} />
        </HashRouter>
      </AntdApp>
    </XProvider>
  )
}

export default App
