import { useNavigate } from 'react-router'
import { Button, Divider, Typography, theme } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import ModelServiceForm from './ModelServiceForm'
import McpConfigEditor from './McpConfigEditor'

function SettingsPage(): React.JSX.Element {
  const navigate = useNavigate()
  const { token } = theme.useToken()

  return (
    <div
      style={{
        height: '100%',
        overflow: 'auto',
        background: token.colorBgLayout
      }}
    >
      <div style={{ maxWidth: 880, margin: '0 auto', padding: token.paddingLG }}>
        <Button
          type="text"
          icon={<ArrowLeftOutlined />}
          onClick={() => navigate('/')}
          style={{ marginBottom: token.margin }}
        >
          返回对话
        </Button>

        <Typography.Title level={4} style={{ marginTop: 0 }}>
          模型服务
        </Typography.Title>
        <ModelServiceForm />

        <Divider />

        <Typography.Title level={4}>MCP 服务</Typography.Title>
        <McpConfigEditor />
      </div>
    </div>
  )
}

export default SettingsPage
