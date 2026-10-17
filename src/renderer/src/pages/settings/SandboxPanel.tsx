import { useEffect, useState } from 'react'
import { Alert, Flex, Switch, Typography, theme } from 'antd'
import type { SandboxExecStatus, SandboxSettings } from '../../../../main/store/types'

interface SandboxPanelProps {
  sandbox: SandboxSettings
  /** 只改 App 那一份预览状态;落库由面板自己在提交时做(与外观、权限同一套) */
  onChange: (next: SandboxSettings) => void
}

/**
 * 沙箱:文件写入的边界,加上 shell 命令那道 OS 级的受限执行。
 *
 * 与外观、权限同一条写入路径(整份 `sandbox` 一个键整体落库),不会出现「开关落了、
 * 别的没落」的半状态;真值只有一份,在 App。
 *
 * 三颗都是**缺省即开**:设置里没有这一键就是边界装着的时候 —— 与「权限里没有 mode 就是最严那档」
 * 同一条纪律,所以这里显示的是「没有显式关掉」而不是「显式打开过」。
 * 唯一的例外是「网络」那颗:它缺省是**放行**,而这一颗的方向与安全无关,是「装包 / 拉代码还能不能用」
 * 的取舍,代价写在它自己的说明里。界面一律读 `!== false`,写反了就变成一颗默认关着的开关。
 */

/**
 * 引擎状态的四种说法。
 *
 * 按 `engine` 分支而不是按 `available`:Windows 那一支 `available` 也是 `true`(没有机制不等于
 * 机制坏了),混在一起就会在界面上写出一句「受限执行可用」而实际什么都没拦。
 * 不可用那两支要说清后果是「拒绝」而不是「退回不受限地跑」—— 用户看到红字最容易猜成后者。
 *
 * `exec` 只用来在「可用但这一颗关着」时补一句:引擎在不在,与这道边界装没装,是两回事。
 * 不补那一句的话,关着开关的人看不到「这里原本能拦」。
 */
function engineAlert(
  status: SandboxExecStatus,
  enabled: boolean,
  exec: boolean
): { type: 'info' | 'warning'; message: string; description: string } {
  if (status.engine === 'none') {
    return {
      type: 'warning',
      message: '这台机器上没有 OS 级的受限执行机制',
      description:
        `${status.reason ?? ''}` +
        '下面那颗「把命令关进受限执行环境」在这台机器上不起作用:文件写入的边界照常装着,而 shell 命令能读写到哪儿,' +
        '仍然只有「权限」那一档拦着。'
    }
  }
  if (status.available) {
    const offNote = exec ? '' : ' 这一颗目前关着,所以命令照旧不受这道约束。'
    return status.engine === 'bwrap'
      ? {
          type: 'info',
          message: '受限执行可用:bubblewrap',
          description:
            '命令看到的是「整盘只读,只有工作空间与临时目录可写」。这一档比 macOS 那边更硬:被点名的凭据目录在命令里不是「读不到」,而是看着像不存在。' +
            offNote
        }
      : {
          type: 'info',
          message: '受限执行可用:sandbox-exec',
          description:
            '命令的写入被内核收在同一个边界里:工作空间与临时目录之外写不进去,清单里点名的凭据目录读不到(报 Operation not permitted)。' +
            offNote
        }
  }
  return {
    type: 'warning',
    message: '受限执行在这台机器上装不上',
    description:
      `${status.reason ?? ''}` +
      (enabled
        ? ' 现在这一栏是开着的,所以 run_command 会被直接拒绝——不会悄悄退回不受限地跑。'
        : ' 这一栏目前关着;把它打开时 run_command 会被直接拒绝,不会悄悄退回不受限地跑。') +
      ' 结论在一次启动内只测一次,装好之后重启应用才认。'
  }
}

interface SwitchRowProps {
  title: string
  checked: boolean
  /** 上一颗关掉时这里点不动:总闸关了就没有根,底下两颗谈不到生效 */
  disabled?: boolean
  onCommit: (checked: boolean) => void
  /** 说明按段给:一段一行,免得一个几百字的字符串在源码里折成看不清的形状 */
  notes: string[]
}

/** 一颗开关加它的几行说明。三行形状完全一样,写成组件免得第三份时漏改一句 */
function SwitchRow({
  title,
  checked,
  disabled,
  onCommit,
  notes
}: SwitchRowProps): React.JSX.Element {
  const { token } = theme.useToken()
  return (
    <Flex vertical gap={token.marginXS}>
      <Flex align="center" gap={token.marginXS}>
        <Typography.Text strong>{title}</Typography.Text>
        <Switch checked={checked} disabled={disabled} onChange={onCommit} />
      </Flex>
      {notes.map((note) => (
        <Typography.Text key={note} type="secondary" style={{ fontSize: 12 }}>
          {note}
        </Typography.Text>
      ))}
    </Flex>
  )
}

function SandboxPanel({ sandbox, onChange }: SandboxPanelProps): React.JSX.Element {
  const enabled = sandbox.enabled !== false
  const exec = sandbox.exec !== false
  // 网络缺省是**放行**:这一颗管的是装包与拉代码能不能用,不是安全方向,
  // 所以它是「缺省即最保守」那条纪律的一次公开例外,由下面那两行说明承担代价。
  const network = sandbox.network !== false
  const [status, setStatus] = useState<SandboxExecStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.settings.sandboxStatus().then((value) => {
      if (!cancelled) setStatus(value)
    })
    return (): void => {
      cancelled = true
    }
  }, [])

  const commit = (next: SandboxSettings): Promise<void> => {
    onChange(next)
    return window.api.settings.set('sandbox', next)
  }

  const alert = status ? engineAlert(status, enabled, exec) : null

  return (
    <Flex vertical gap="middle" style={{ maxWidth: 760 }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        这是第一道<strong>结构性</strong>护栏:不由人点头,模型也写不到工作空间外面去 —— 直接写(
        <code>write_file</code>)和命令里写(<code>run_command</code>)两条都是。
        它和「权限」那一档是两道独立的闸 —— 审批管「要不要问」,这里管「做不做得成」。
      </Typography.Paragraph>

      {alert && (
        <Alert
          type={alert.type}
          showIcon
          message={alert.message}
          description={
            <Typography.Text style={{ fontSize: 12 }}>{alert.description}</Typography.Text>
          }
        />
      )}

      <SwitchRow
        title="把文件写入限制在本次会话的工作空间内"
        checked={enabled}
        onCommit={(checked) => void commit({ ...sandbox, enabled: checked })}
        notes={[
          '这一颗是下面两颗的总闸:关掉它,写入边界与受限执行一起关(没有工作空间就没有根)。',
          '开着时,解析后落在目录外的 write_file 会被直接拒绝 —— 不弹审批卡片,因为卡片不该承诺一件注定失败的事。关掉后回到「照样写,只在结果里附一行越界说明」,要不要问就看「权限」那一档。判定走 realpath,所以工作空间里指向外面的软链也出不去。',
          '正在跑的那一轮按它开始时的设置跑完,下一次发消息才跟着这里变。'
        ]}
      />

      <SwitchRow
        title="把 run_command 关进受限执行环境"
        checked={exec}
        disabled={!enabled}
        onCommit={(checked) => void commit({ ...sandbox, exec: checked })}
        notes={[
          'macOS 用 sandbox-exec、Linux 用 bubblewrap,由内核把命令包住:它的写入只在工作空间与临时目录里,清单点名的凭据目录(~/.ssh、~/.aws、~/.gnupg、~/.netrc、~/.config/gh、钥匙串目录)读不到,环境变量只带一份白名单。',
          '两个后果要事先知道:被这道边界拦下的命令是非零退出,那不是它自己的故障;而 SSH_AUTH_SOCK 不在白名单里,所以沙箱里 git 走 ssh 会失败。构建命令需要写工作空间外面时,关这一颗就够,上一颗的文件边界仍然装着。',
          '这一颗关掉后命令回到原来的行为:整台机器都能读写,要不要问只看「权限」那一档。'
        ]}
      />

      <SwitchRow
        title="允许受限执行里的网络访问"
        checked={network}
        disabled={!enabled || !exec}
        onCommit={(checked) => void commit({ ...sandbox, network: checked })}
        notes={[
          '默认放行:装包、拉代码、curl 照旧能用。代价是把内容传到外面这条路拦不住 —— 这一层管文件,不管数据出境。',
          '关掉后被关起来的那些命令连不上网(curl、npm install、pip 都会失败),而非受限的那一支(Windows、上一颗关着时)照旧通 —— 这一颗只管被关起来的那批命令。'
        ]}
      />

      <Flex vertical gap={4}>
        <Typography.Text strong>这一栏仍然不是沙箱</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          ① 它管的是「写」,以及「点名读不到的那几个目录」:read_file 仍然读得到工作空间之外的一切,
          而命令那边那份凭据清单是人工维护的,注定列不全。
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          ② 两台机器的硬度不一样:Linux 那边是整盘只读加两个可写目录,mac 这边是整盘可读加点名 deny ——
          同一句「受约束」在两边拦住的东西不是同一批。mac 上的钥匙串走 securityd 那个服务,只 deny
          文件路径挡不住它。
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          ③ 没选工作空间的会话仍然没有边界:没有根就没有那道闸门,它照旧靠「权限」那一档逐条问。
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          ④ MCP 工具完全不在这层的覆盖里:它既不走 run_command,也不走 write_file。
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          所以这里做到的是「一次误点允许的后果,从改了整台机器退成改了授权范围内的东西」,
          而「这台机器上跑的就是模型写的代码」那件事没有变。
        </Typography.Text>
      </Flex>
    </Flex>
  )
}

export default SandboxPanel
