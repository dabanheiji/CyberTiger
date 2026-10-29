import { useEffect, useState } from 'react'
import {
  Alert,
  App,
  Button,
  Divider,
  Flex,
  List,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  theme,
  type TableColumnsType
} from 'antd'
import {
  FolderOpenOutlined,
  FileTextOutlined,
  PlusOutlined,
  ReloadOutlined
} from '@ant-design/icons'
import type { IpcResult } from '../../../../main/chat/dto'
import type { HookDecision, HookExecution } from '../../../../main/hooks/dto'
import type { HookDraft, HookMeta } from '../../../../main/hooks/types'
import { useHooks } from '../../hooks/useHooks'
import HookFormDrawer from './HookFormDrawer'

/** 六个结论各自说什么;界面上一行只放得下这两个字 */
const DECISION_LABEL: Record<HookDecision, string> = {
  blocked: '拦下',
  adopted: '采纳',
  noop: '空跑',
  rejected: '改写被拒',
  skipped: '跳过',
  failed: '失败'
}

const DECISION_COLOR: Record<HookDecision, string> = {
  blocked: 'volcano',
  adopted: 'blue',
  noop: 'default',
  rejected: 'gold',
  skipped: 'gold',
  failed: 'red'
}

/** 失败与跳过的来由:这一格要说清「没跑」和「跑了但没结论」是两件事 */
const FAILURE_TEXT: Record<string, string> = {
  'spawn-error': '程序起不来',
  timeout: '超时',
  aborted: '这一轮已中止',
  'bad-output': '输出不是合法的回执',
  'payload-too-large': '要送的数据太大,没进管道',
  'no-boundary': '那道边界建不出来',
  'rewrite-rejected': '那份改写没过结构守卫'
}

/** Windows 上不经 shell 起不来的包装器:这一台上没有别的写法能救它 */
function windowsWrapperHint(command: string): string | null {
  if (window.electron.process.platform !== 'win32') return null
  return /\.(bat|cmd)$/i.test(command.trim())
    ? '这台机器上 .bat / .cmd 包装器不经 shell 起不来，请把程序换成 .exe 或写成绝对路径。'
    : null
}

/**
 * 「跑在哪一侧」的颜色。
 *
 * 声明里 `sandboxed: true` 而界面却说「未受限」时,那正是用户以为自己开了边界、实际没有的那一类,
 * 所以要上警示色;`不会运行` 更严重,直接红。
 */
function runsAsColor(runsAs: string): string | undefined {
  if (runsAs.startsWith('不会运行')) return 'red'
  if (runsAs.startsWith('受限')) return 'green'
  if (runsAs.startsWith('未受限(默认)')) return undefined
  return 'orange'
}

/** 那一次触发到底说了什么:结论之后补上钩子自己写给人的那句 */
function executionDetail(exec: HookExecution): string {
  const head = (() => {
    if (exec.failure) return FAILURE_TEXT[exec.failure] ?? exec.failure
    if (exec.decision === 'blocked') return exec.reason || '拦下了,没给理由'
    if (exec.decision === 'adopted') {
      const parts = [
        exec.note,
        exec.rewritten ? `已改写请求(${String(exec.msgCount ?? 0)} 条消息)` : ''
      ]
      return parts.filter(Boolean).join(' · ')
    }
    if (exec.decision === 'skipped') return exec.why ?? '这次没跑'
    if (exec.decision === 'rejected') return '那份改写没过守卫,发出去的还是原本那一份'
    return '跑完了,没有可采纳的东西'
  })()
  const tail = [exec.log, exec.reason && exec.decision !== 'blocked' ? exec.reason : '', exec.err]
    .filter(Boolean)
    .join(' ｜ ')
  return [head, tail].filter(Boolean).join(' ｜ ')
}

function shortTime(ts: string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}:${pad(date.getSeconds())}`
}

const RECENT_LIMIT = 50

/**
 * 钩子管理:声明目录是唯一事实来源,这一页是它的编辑器 + 那份日志的读数窗。
 */
function HooksPanel(): React.JSX.Element {
  const { message, modal } = App.useApp()
  const { token } = theme.useToken()
  const { hooks, dir, logPath } = useHooks()

  const [formOpen, setFormOpen] = useState(false)
  // null = 新建
  const [formHook, setFormHook] = useState<HookMeta | null>(null)
  const [recent, setRecent] = useState<HookExecution[]>([])
  // 手动「重新读取」不另开一条数据流:它只是让下面那个 effect 再跑一次
  const [reloadTick, setReloadTick] = useState(0)

  /**
   * 「最近执行」是拉取式的:钩子每触发一次就追加一行,没有事件可订阅(与 `chat:pendingApprovals` 同一条路)。
   * 目录变化后重读一次,是因为关掉/删掉一条钩子时用户紧接着就会想看它之前跑成什么样。
   */
  useEffect(() => {
    let cancelled = false
    window.api.hooks.recent(RECENT_LIMIT).then((res) => {
      if (!cancelled && res.success) setRecent(res.data)
    })
    return (): void => {
      cancelled = true
    }
  }, [hooks, reloadTick])

  const handleToggle = async (meta: HookMeta, enabled: boolean): Promise<void> => {
    const res = await window.api.hooks.setEnabled(meta.name, enabled)
    if (!res.success) message.error(res.msg)
  }

  const handleSubmit = async (draft: HookDraft): Promise<boolean> => {
    const res = formHook
      ? await window.api.hooks.update(formHook.name, draft)
      : await window.api.hooks.create(draft)
    if (!res.success) {
      message.error(res.msg)
      return false
    }
    message.success(formHook ? '已保存' : `已创建钩子 ${draft.name}`)
    return true
  }

  const handleDelete = (meta: HookMeta): void => {
    modal.confirm({
      title: '删除钩子',
      content: `将删除「${meta.name}」的目录及其中的全部文件(包括那条程序本身),无法恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async (): Promise<void> => {
        const res = await window.api.hooks.remove(meta.name)
        if (!res.success) message.error(res.msg)
        else message.success(`已删除 ${meta.name}`)
      }
    })
  }

  /** 打开目录 / 打开日志:失败要说出来,否则点了没反应看起来像按钮坏了 */
  const reveal = async (fn: () => Promise<IpcResult<null>>): Promise<void> => {
    const res = await fn()
    if (!res.success) message.error(res.msg)
  }

  const columns: TableColumnsType<HookExecution> = [
    { title: '时间', dataIndex: 'ts', width: 130, render: (ts: string) => shortTime(ts) },
    { title: '时机', dataIndex: 'event', width: 120 },
    {
      title: '钩子',
      dataIndex: 'hook',
      width: 140,
      render: (hook: string, exec) => (
        <Space size={4}>
          <span>{hook}</span>
          {exec.depth > 0 && <Tag>子</Tag>}
        </Space>
      )
    },
    {
      title: '结论',
      dataIndex: 'decision',
      width: 96,
      render: (decision: HookDecision) => (
        <Tag color={DECISION_COLOR[decision]}>{DECISION_LABEL[decision]}</Tag>
      )
    },
    {
      title: '详情',
      key: 'detail',
      render: (_v, exec) => (
        <Typography.Paragraph
          type="secondary"
          ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}
          style={{ margin: 0, fontSize: 12 }}
        >
          {executionDetail(exec)}
          {exec.exit !== null && exec.exit !== undefined && exec.exit !== 0
            ? ` ｜ 退出码 ${String(exec.exit)}`
            : ''}
        </Typography.Paragraph>
      )
    }
  ]

  return (
    <Flex vertical gap="middle" style={{ maxWidth: 880 }}>
      <Alert
        type="warning"
        showIcon
        message="钩子是你自己写的程序，它会以这个应用的权限直接运行。"
        description={
          <Flex vertical gap={4}>
            <Typography.Text style={{ fontSize: 13 }}>
              1. 钩子里的 <code>command</code>{' '}
              是一段真实的可执行程序：读写这台机器上的文件、访问网络、启动进程。它做的事不受本应用的清单与规则约束。
            </Typography.Text>
            <Typography.Text style={{ fontSize: 13 }}>
              2. <strong>钩子不经过审批。</strong>
              「问不问你」那道闸门只管模型发起的工具调用；钩子是你自己配的，不是模型决定的，所以它不弹卡片、黑白名单也拦不到它。要停下它只有在这页把它关掉。
            </Typography.Text>
            <Typography.Text style={{ fontSize: 13 }}>
              3. <strong>默认它按全权限运行。</strong>只有声明了 <code>sandboxed: true</code>{' '}
              的钩子才会被放进与 <code>run_command</code> 同一个受限执行环境，而那道边界
              <strong>要有前提</strong>：本次会话没选工作空间时根本建不出来——那种情况下这条钩子会被
              <strong>跳过并写明理由</strong>
              ，应用不会退回「不受限地把它跑一遍」。你把「沙箱」那一栏关掉时，它是按你的指示不受限地运行。
            </Typography.Text>
            <Typography.Text style={{ fontSize: 13 }}>
              4.{' '}
              <strong>
                <code>beforeRequest</code> 能看到并发回整份发给模型的对话内容
              </strong>
              （含之前每一步的工具结果）。改写只影响这一步发出去的那一份：聊天记录、发给模型的原始历史都不变。改写整段会让这个会话的提示缓存从头重算一次，所以默认建议配{' '}
              <code>once</code> 或 matcher 收窄。
            </Typography.Text>
            <Typography.Text style={{ fontSize: 13 }}>
              5. <strong>子 Agent 跑的每一步同样触发钩子</strong>，覆盖面与审批闸门一致——让模型走{' '}
              <code>task</code> 绕不开它。
            </Typography.Text>
            <Typography.Text style={{ fontSize: 13 }}>
              6. 每次触发的结论都记在 <code>userData/logs/hooks.jsonl</code>
              ，本页「最近执行」读的就是它。
              <strong>
                这份文件里只写结论（拦没拦、注了什么、改写有没有被采纳、几条消息），不写对话正文
              </strong>
              ；正文本来就在你的会话数据库里，我们不再抄一份到别处。
            </Typography.Text>
          </Flex>
        }
      />

      <Flex align="center" justify="space-between">
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          声明放在 <code>{dir || 'hooks 目录'}</code>,每个目录一份 <code>HOOK.md</code>
          ;放进目录即出现在下面这份列表里。
        </Typography.Text>
        <Space>
          <Button
            size="small"
            icon={<FolderOpenOutlined />}
            onClick={() => void reveal(() => window.api.hooks.openDir())}
          >
            打开目录
          </Button>
          <Button
            size="small"
            icon={<FileTextOutlined />}
            onClick={() => void reveal(() => window.api.hooks.openLog())}
          >
            打开日志
          </Button>
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setFormHook(null)
              setFormOpen(true)
            }}
          >
            新建钩子
          </Button>
        </Space>
      </Flex>

      <List
        size="small"
        bordered
        locale={{ emptyText: '还没有装任何钩子' }}
        dataSource={hooks}
        renderItem={(row) => {
          // 一次算完那一句:同一行里判断两次、印两次是第二种错
          const wrapperHint = row.error ? null : windowsWrapperHint(row.meta.command)
          return (
            <List.Item
              actions={[
                <Switch
                  key="enabled"
                  size="small"
                  checked={row.meta.enabled}
                  disabled={!!row.error}
                  onChange={(value) => void handleToggle(row.meta, value)}
                />,
                <Button
                  key="edit"
                  size="small"
                  type="link"
                  onClick={() => {
                    setFormHook(row.meta)
                    setFormOpen(true)
                  }}
                >
                  编辑
                </Button>,
                <Button
                  key="delete"
                  size="small"
                  type="link"
                  danger
                  onClick={() => handleDelete(row.meta)}
                >
                  删除
                </Button>
              ]}
            >
              <List.Item.Meta
                title={
                  <Space wrap>
                    <span>{row.meta.name}</span>
                    <Tag>{row.meta.event}</Tag>
                    <Tag color={runsAsColor(row.runsAs)}>{row.runsAs}</Tag>
                    {row.meta.once && <Tag>每轮一次</Tag>}
                    {row.meta.matcher.length > 0 && (
                      <Tag>{`matcher ${String(row.meta.matcher.length)} 条`}</Tag>
                    )}
                  </Space>
                }
                description={
                  <Flex vertical gap={2}>
                    {row.error ? (
                      <Typography.Text type="danger">无法加载:{row.error}</Typography.Text>
                    ) : (
                      <Typography.Text>{row.meta.description}</Typography.Text>
                    )}
                    {!row.error && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        <code>{row.meta.command}</code>
                        {row.meta.args.length > 0 ? ` ${row.meta.args.join(' ')} ` : ''}
                        {`｜ ${String(row.meta.timeoutMs)} 毫秒超时`}
                      </Typography.Text>
                    )}
                    {/* 写错目录只有一行 ENOENT 日志:看不见解析结果就等于钩子凭空失灵。
                        主进程对「按 PATH 查找的那一个」给空串,所以两种情形各说一句,不猜 */}
                    {!row.error &&
                      (row.resolvedPath === '' ? (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          按 PATH 查找这个命令名
                        </Typography.Text>
                      ) : (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          解析到 <code>{row.resolvedPath}</code>
                        </Typography.Text>
                      ))}
                    {wrapperHint && (
                      <Typography.Text type="warning" style={{ fontSize: 12 }}>
                        {wrapperHint}
                      </Typography.Text>
                    )}
                  </Flex>
                }
              />
            </List.Item>
          )
        }}
      />

      {hooks.some((row) => row.error) && (
        <Alert
          type="warning"
          showIcon
          message="有钩子无法加载"
          description="修好对应目录里的 HOOK.md(或直接删掉那个目录)后会自动重新扫描;坏掉的那一条不会被触发,也不会拦下任何事。"
        />
      )}

      <Divider style={{ margin: `${token.margin}px 0` }} />

      <Flex align="center" justify="space-between">
        <Space>
          <Typography.Text strong>最近执行</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            最多 {RECENT_LIMIT} 次,新的在前
          </Typography.Text>
        </Space>
        <Button size="small" icon={<ReloadOutlined />} onClick={() => setReloadTick((n) => n + 1)}>
          重新读取
        </Button>
      </Flex>
      <Table<HookExecution>
        size="small"
        rowKey={(exec) => `${exec.ts}-${exec.hook}-${exec.event}-${exec.step}`}
        columns={columns}
        dataSource={recent}
        pagination={false}
        locale={{ emptyText: '还没有触发记录' }}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        这份日志只写结论,不写对话正文;完整的一份在 <code>{logPath || 'logs/hooks.jsonl'}</code>。
      </Typography.Text>

      <HookFormDrawer
        open={formOpen}
        hook={formHook}
        onClose={() => setFormOpen(false)}
        onSubmit={handleSubmit}
      />
    </Flex>
  )
}

export default HooksPanel
