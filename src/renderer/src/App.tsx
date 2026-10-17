import { useEffect, useMemo, useState } from 'react'
import { HashRouter, useLocation } from 'react-router'
import { App as AntdApp } from 'antd'
import { XProvider } from '@ant-design/x'
import antdZhCN from 'antd/locale/zh_CN'
import xZhCN from '@ant-design/x/locale/zh_CN'
import type {
  AppearanceSettings,
  PermissionSettings,
  SandboxSettings
} from '../../main/store/types'
import { useSystemTheme } from './hooks/useSystemTheme'
import { buildTheme, defaultAccent, focusRing, selectionTint } from './theme'
import ChatPage from './pages/chat'
import SettingsPage from './pages/settings'

/**
 * 聊天页始终挂载:它持有会话、流式状态和发送标志,卸载会丢失进行中的回复。
 * 进入设置页时只是把聊天页隐藏。
 *
 * 外观、权限与沙箱设置只在这条链上传递(App → 聊天页 / 设置页 → 面板):`settings:*` 本来就是
 * pull-only、没有 change 事件,所以「谁是当前值」必须只有一处。权限这一档尤其明显 ——
 * 底栏那颗选择器和设置页的名单编辑写的是同一个键,两处各自读 store 就会出现界面互相打架。
 * 沙箱只由设置页那一个面板写,但它和另两键走同一次挂载读取,免得出现「设置页打开了、
 * jail 的当前开关还停在空值」那种半屏旧状态。
 */
function Routes(props: {
  appearance: AppearanceSettings
  onAppearanceChange: (next: AppearanceSettings) => void
  permissions: PermissionSettings
  onPermissionsChange: (next: PermissionSettings) => void
  sandbox: SandboxSettings
  onSandboxChange: (next: SandboxSettings) => void
}): React.JSX.Element {
  const { pathname } = useLocation()
  const onSettings = pathname === '/settings'
  return (
    <>
      <div style={{ height: '100%', display: onSettings ? 'none' : undefined }}>
        <ChatPage permissions={props.permissions} onPermissionsChange={props.onPermissionsChange} />
      </div>
      {onSettings && <SettingsPage {...props} />}
    </>
  )
}

function App(): React.JSX.Element {
  const isDark = useSystemTheme()
  const [appearance, setAppearance] = useState<AppearanceSettings>({})
  const [permissions, setPermissions] = useState<PermissionSettings>({})
  // 空对象即「没设置过」,而 jail 的缺省语义是**开** —— 判断在主进程那侧
  // (`sandbox.ts` 只认 `enabled === false`),这里照空值传下去不会把边界关掉
  const [sandbox, setSandbox] = useState<SandboxSettings>({})

  // 只在挂载时读一次:明暗模式由主进程落到 nativeTheme,渲染层跟着 media query 走,
  // 这里要的只是用户自定义的强调色;权限与沙箱同理 —— 只由写入方更新,不需要轮询
  useEffect(() => {
    void (async (): Promise<void> => {
      const [nextAppearance, nextPermissions, nextSandbox] = await Promise.all([
        window.api.settings.get('appearance'),
        window.api.settings.get('permissions'),
        window.api.settings.get('sandbox')
      ])
      setAppearance(nextAppearance ?? {})
      setPermissions(nextPermissions ?? {})
      setSandbox(nextSandbox ?? {})
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
          <Routes
            appearance={appearance}
            onAppearanceChange={setAppearance}
            permissions={permissions}
            onPermissionsChange={setPermissions}
            sandbox={sandbox}
            onSandboxChange={setSandbox}
          />
        </HashRouter>
      </AntdApp>
    </XProvider>
  )
}

export default App
