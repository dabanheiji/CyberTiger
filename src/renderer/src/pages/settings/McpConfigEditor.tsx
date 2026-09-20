import { useEffect, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { json } from '@codemirror/lang-json'
import { Alert, App, Badge, Button, Flex, List, Space, Typography, theme } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import type { McpServerStatus } from '../../../../main/mcp/types'
import { useSystemTheme } from '../../hooks/useSystemTheme'

const EXAMPLE = `{
  "mcpServers": {
    "time": {
      "command": "uvx",
      "args": ["mcp-server-time"]
    },
    "remote": {
      "url": "http://localhost:3000/mcp",
      "disabled": true
    }
  }
}`

const STATE_LABEL: Record<McpServerStatus['state'], { text: string; status: 'default' | 'processing' | 'success' | 'error' }> = {
  disabled: { text: '已禁用', status: 'default' },
  connecting: { text: '连接中', status: 'processing' },
  connected: { text: '已连接', status: 'success' },
  error: { text: '连接失败', status: 'error' }
}

/** MCP 配置:JSON 编辑器 + 各 server 的连接状态 */
function McpConfigEditor(): React.JSX.Element {
  const { message } = App.useApp()
  const { token } = theme.useToken()
  const isDark = useSystemTheme()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [statuses, setStatuses] = useState<McpServerStatus[]>([])

  // 挂载时读取配置与状态,并订阅后续状态变化
  useEffect(() => {
    let cancelled = false
    window.api.settings.get('mcpServers').then((config) => {
      if (cancelled) return
      setValue(JSON.stringify(config ?? { mcpServers: {} }, null, 2))
    })
    window.api.mcp.getStatus().then((res) => {
      if (!cancelled && res.success) setStatuses(res.data.statuses)
    })
    const unsubscribe = window.api.mcp.onStatus(setStatuses)
    return (): void => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const res = await window.api.mcp.saveConfig(value)
      if (!res.success) {
        setError(res.msg)
        return
      }
      // 保存成功后按格式化后的文本回显
      setValue(JSON.stringify(JSON.parse(value), null, 2))
      message.success('MCP 配置已保存,正在连接')
    } finally {
      setSaving(false)
    }
  }

  const handleReload = async (): Promise<void> => {
    const res = await window.api.mcp.reload()
    if (!res.success) message.error(res.msg)
  }

  return (
    <Flex vertical gap="middle" style={{ maxWidth: 760 }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        与 Claude Desktop 相同的 JSON 格式。本地进程填 command / args / env,远程服务填
        url / headers,disabled 为 true 时不连接。
      </Typography.Paragraph>
      <div style={{ border: `1px solid ${token.colorBorder}`, borderRadius: token.borderRadius, overflow: 'hidden' }}>
        <CodeMirror
          value={value}
          height="360px"
          theme={isDark ? 'dark' : 'light'}
          extensions={[json()]}
          onChange={setValue}
          placeholder={EXAMPLE}
          basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }}
        />
      </div>
      {error && <Alert type="error" showIcon message={error} />}
      <Space>
        <Button type="primary" loading={saving} onClick={handleSave}>
          保存并连接
        </Button>
        <Button icon={<ReloadOutlined />} onClick={handleReload}>
          重新连接全部
        </Button>
      </Space>
      <List
        size="small"
        bordered
        locale={{ emptyText: '尚未配置 MCP server' }}
        dataSource={statuses}
        renderItem={(s) => {
          const label = STATE_LABEL[s.state]
          return (
            <List.Item>
              <List.Item.Meta
                title={
                  <Space>
                    <span>{s.name}</span>
                    <Badge status={label.status} text={label.text} />
                    {s.state === 'connected' && (
                      <Typography.Text type="secondary">{s.tools.length} 个工具</Typography.Text>
                    )}
                  </Space>
                }
                description={
                  s.state === 'error'
                    ? <Typography.Text type="danger">{s.error}</Typography.Text>
                    : s.tools.length > 0
                      ? s.tools.map((t) => t.name).join('、')
                      : undefined
                }
              />
            </List.Item>
          )
        }}
      />
    </Flex>
  )
}

export default McpConfigEditor
