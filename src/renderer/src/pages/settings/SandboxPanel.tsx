import { Flex, Switch, Typography, theme } from 'antd'
import type { SandboxSettings } from '../../../../main/store/types'

interface SandboxPanelProps {
  sandbox: SandboxSettings
  /** 只改 App 那一份预览状态;落库由面板自己在提交时做(与外观、权限同一套) */
  onChange: (next: SandboxSettings) => void
}

/**
 * 沙箱:文件写入的边界。
 *
 * 与外观、权限同一条写入路径(整份 `sandbox` 一个键整体落库),不会出现「开关落了、
 * 别的没落」的半状态;真值只有一份,在 App。
 *
 * 缺省即**开**:设置里没有这一键就是边界装着的时候 —— 与「权限里没有 mode 就是最严那档」
 * 同一条纪律,所以这一颗开关显示的是「没有显式关掉」而不是「显式打开过」。
 */
function SandboxPanel({ sandbox, onChange }: SandboxPanelProps): React.JSX.Element {
  const { token } = theme.useToken()
  const enabled = sandbox.enabled !== false

  const commit = (next: SandboxSettings): Promise<void> => {
    onChange(next)
    return window.api.settings.set('sandbox', next)
  }

  return (
    <Flex vertical gap="middle" style={{ maxWidth: 760 }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        这是第一道<strong>结构性</strong>护栏:不由人点头,模型也写不到工作空间外面去。
        它和「权限」那一档是两道独立的闸 —— 审批管「要不要问」,这里管「做不做得成」。
      </Typography.Paragraph>

      <Flex vertical gap={token.marginXS}>
        <Flex align="center" gap={token.marginXS}>
          <Typography.Text strong>把文件写入限制在本次会话的工作空间内</Typography.Text>
          <Switch
            checked={enabled}
            onChange={(checked) => {
              void commit({ ...sandbox, enabled: checked })
            }}
          />
        </Flex>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          开着时,解析后落在目录外的 <code>write_file</code> 会被直接拒绝(不弹审批卡片,
          因为卡片不该承诺一件注定失败的事);关掉后回到「照样写,只在结果里附一行越界说明」,
          要不要问就看「权限」那一档。判定走 <code>realpath</code>,
          所以工作空间里指向外面的软链也出不去。
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          正在跑的那一轮按它开始时的设置跑完,下一次发消息才跟着这里变。
        </Typography.Text>
      </Flex>

      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
        三条它挡不住的:① <strong>读</strong>不收这一限制,工作空间外的文件仍读得到(
        也仍会按「权限」那一档弹审批);② <code>run_command</code> 不收这一限制, 命令里怎么读写都归
        shell 自己 —— 受限执行环境是下一期的事, 而 Windows 上连那一期都没有对应机制,shell
        会一直不受这条约束; ③ 没选工作空间的会话仍然没有边界,那种会话的越界写入仍然只有审批拦着。
      </Typography.Paragraph>
    </Flex>
  )
}

export default SandboxPanel
