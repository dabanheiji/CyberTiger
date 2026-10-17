import { Button, ColorPicker, Divider, Flex, Segmented, Typography, theme } from 'antd'
import type { AppearanceSettings, ThemeMode } from '../../../../main/store/types'
import { DEFAULT_ACCENT_LIGHT } from '../../theme'

interface AppearancePanelProps {
  appearance: AppearanceSettings
  /** 只改渲染层的预览状态;落库由面板自己在提交时做 */
  onChange: (next: AppearanceSettings) => void
}

const MODES: { label: string; value: ThemeMode }[] = [
  { label: '跟随系统', value: 'system' },
  { label: '亮色', value: 'light' },
  { label: '暗色', value: 'dark' }
]

/** Segmented 给的是 string|number,回到 ThemeMode 靠穷举而不是断言 —— 认不出的一律跟随系统 */
function toMode(value: string | number): ThemeMode {
  return value === 'light' || value === 'dark' ? value : 'system'
}

/** 推荐色:第一个是默认虎橙,后面几个是明暗两侧都站得住的色相 */
const PRESET_COLORS = [
  DEFAULT_ACCENT_LIGHT,
  '#1677ff',
  '#722ed1',
  '#13c2c2',
  '#f5222d',
  '#faad14',
  '#52c41a'
]

/**
 * 外观:明暗模式 + 自定义强调色。
 * 模式改动要过一趟主进程(写 `nativeTheme.themeSource`),强调色只留在渲染层,
 * 所以两条路都写同一个 `appearance` 键,但只有前者会触发窗口底色跟着变。
 */
function AppearancePanel({ appearance, onChange }: AppearancePanelProps): React.JSX.Element {
  const { token } = theme.useToken()
  // 色盘显示的是当前真正生效的强调色:没自定义过就是主题那一对(暗色下是更亮的那个)
  const accent = appearance.accent ?? token.colorPrimary

  const commit = (next: AppearanceSettings): Promise<void> => {
    onChange(next)
    return window.api.settings.set('appearance', next)
  }

  return (
    <Flex vertical gap="middle" style={{ maxWidth: 760 }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        界面配色。明暗模式对整应用生效,连窗口顶栏的底色一起;强调色只改按钮、气泡与光晕那一档
        颜色,背景的三级层次保持固定。
      </Typography.Paragraph>

      <Flex vertical gap={token.marginXS}>
        <Typography.Text strong>明暗模式</Typography.Text>
        <Segmented
          value={appearance.mode ?? 'system'}
          options={MODES}
          onChange={(value) => {
            void commit({ ...appearance, mode: toMode(value) })
          }}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          「跟随系统」会随系统外观即时切换,亮色 / 暗色则是把应用钉在这一档。
        </Typography.Text>
      </Flex>

      <Divider style={{ margin: `${token.margin}px 0` }} />

      <Flex vertical gap={token.marginXS}>
        <Typography.Text strong>强调色</Typography.Text>
        <Flex align="center" gap={token.marginXS}>
          <ColorPicker
            value={accent}
            format="hex"
            // 只让选纯色:透明度会让按钮上的文字对比度失控,而淡染本来就按固定 alpha 算
            disabledAlpha
            showText
            presets={[{ label: '推荐', colors: PRESET_COLORS }]}
            // 拖动色盘只更新预览:那是一条高频回调,每次都写 store 等于刷配置文件
            onChange={(_value, css) => {
              onChange({ ...appearance, accent: css })
            }}
            onChangeComplete={(value) => {
              void commit({ ...appearance, accent: value.toHexString() })
            }}
          />
          <Button
            size="small"
            onClick={() => {
              void commit({ ...appearance, accent: undefined })
            }}
          >
            恢复默认
          </Button>
        </Flex>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          只选一个颜色:暗色下自动把明度抬到压得过深色背景,色相与饱和度都不动。
        </Typography.Text>
      </Flex>
    </Flex>
  )
}

export default AppearancePanel
