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
  Tag,
  Typography,
  theme
} from 'antd'
import { FolderOpenOutlined, PlusOutlined } from '@ant-design/icons'
import type { AgentDraft, AgentMeta, AgentToolOption } from '../../../../main/agents/types'
import type { ModelProvider } from '../../../../main/store/types'
import { useAgents } from '../../hooks/useAgents'
import AgentFormDrawer from './AgentFormDrawer'

/** 子 Agent 管理:内置角色只读展示,自定义角色可新建 / 编辑 / 启停 / 删除 */
function AgentsPanel(): React.JSX.Element {
  const { message, modal } = App.useApp()
  const { token } = theme.useToken()
  const agents = useAgents()

  // 未设置过视为开启,与主进程的默认值保持一致
  const [enableSubAgent, setEnableSubAgent] = useState(true)
  const [providers, setProviders] = useState<ModelProvider[]>([])
  const [tools, setTools] = useState<AgentToolOption[]>([])
  const [formOpen, setFormOpen] = useState(false)
  // null = 新建
  const [formAgent, setFormAgent] = useState<AgentMeta | null>(null)

  useEffect(() => {
    void (async () => {
      const settings = await window.api.settings.getAll()
      setEnableSubAgent(settings.enableSubAgent !== false)
      setProviders(settings.providers ?? [])
    })()
  }, [])

  const handleEnableSubAgent = async (value: boolean): Promise<void> => {
    setEnableSubAgent(value)
    await window.api.settings.set('enableSubAgent', value)
  }

  const handleToggle = async (agent: AgentMeta, value: boolean): Promise<void> => {
    const res = await window.api.agents.setEnabled(agent.name, value)
    if (!res.success) message.error(res.msg)
  }

  /** 打开表单前拉一次工具列表:MCP 的连接状态随时会变 */
  const openForm = async (agent: AgentMeta | null): Promise<void> => {
    const res = await window.api.agents.listTools()
    if (res.success) setTools(res.data.tools)
    setFormAgent(agent)
    setFormOpen(true)
  }

  const handleSubmit = async (draft: AgentDraft): Promise<boolean> => {
    const res = formAgent
      ? await window.api.agents.update(formAgent.name, draft)
      : await window.api.agents.create(draft)
    if (!res.success) {
      message.error(res.msg)
      return false
    }
    message.success(formAgent ? '已保存' : `已创建角色 ${draft.name}`)
    return true
  }

  const handleDelete = (agent: AgentMeta): void => {
    modal.confirm({
      title: '删除子 Agent 角色',
      content: `将删除角色「${agent.name}」的目录及其中的全部文件,无法恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async (): Promise<void> => {
        const res = await window.api.agents.remove(agent.name)
        if (!res.success) message.error(res.msg)
        else message.success(`已删除 ${agent.name}`)
      }
    })
  }

  const builtin = agents.filter((a) => a.builtin)
  const custom = agents.filter((a) => !a.builtin)

  return (
    <div>
      <Flex align="center" justify="space-between" style={{ marginBottom: token.marginXS }}>
        <Space>
          <Switch checked={enableSubAgent} onChange={handleEnableSubAgent} />
          <Typography.Text>允许主 Agent 派生子 Agent</Typography.Text>
        </Space>
        <Space>
          <Button
            size="small"
            icon={<FolderOpenOutlined />}
            onClick={() => void window.api.agents.openDir()}
          >
            打开角色目录
          </Button>
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            disabled={!enableSubAgent}
            onClick={() => void openForm(null)}
          >
            新建角色
          </Button>
        </Space>
      </Flex>
      <Typography.Paragraph type="secondary" style={{ marginBottom: token.margin }}>
        关闭后主 Agent 不再持有 task 工具,角色目录也不会出现在提示词里。
      </Typography.Paragraph>

      <Typography.Text strong>内置角色</Typography.Text>
      <List
        size="small"
        dataSource={builtin}
        style={{ marginTop: token.marginXS }}
        renderItem={(agent) => (
          <List.Item>
            <List.Item.Meta
              title={
                <Space>
                  <span>{agent.name}</span>
                  <Tag>内置</Tag>
                </Space>
              }
              description={agent.description}
            />
          </List.Item>
        )}
      />

      <Divider style={{ margin: `${token.margin}px 0` }} />

      <Typography.Text strong>自定义角色</Typography.Text>
      {custom.length === 0 ? (
        <Typography.Paragraph type="secondary" style={{ marginTop: token.marginXS }}>
          还没有自定义角色。新建后主 Agent 就能按描述挑选它来执行子任务。
        </Typography.Paragraph>
      ) : (
        <List
          size="small"
          dataSource={custom}
          style={{ marginTop: token.marginXS }}
          renderItem={(agent) => (
            <List.Item
              actions={[
                <Switch
                  key="enabled"
                  size="small"
                  checked={agent.enabled}
                  disabled={!!agent.error}
                  onChange={(value) => void handleToggle(agent, value)}
                />,
                <Button key="edit" size="small" type="link" onClick={() => void openForm(agent)}>
                  编辑
                </Button>,
                <Button
                  key="delete"
                  size="small"
                  type="link"
                  danger
                  onClick={() => handleDelete(agent)}
                >
                  删除
                </Button>
              ]}
            >
              <List.Item.Meta
                title={
                  <Space wrap>
                    <span>{agent.name}</span>
                    {agent.model && <Tag color="blue">模型 {agent.model}</Tag>}
                    <Tag>{agent.tools?.length ? `${agent.tools.length} 个工具` : '全部工具'}</Tag>
                  </Space>
                }
                description={
                  agent.error ? (
                    <Typography.Text type="danger">{agent.error}</Typography.Text>
                  ) : (
                    agent.description
                  )
                }
              />
            </List.Item>
          )}
        />
      )}

      {custom.some((a) => a.error) && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: token.margin }}
          message="有角色无法加载"
          description="修正对应目录下的 AGENT.md(或直接删除该目录)后会自动重新扫描。"
        />
      )}

      <AgentFormDrawer
        open={formOpen}
        agent={formAgent}
        providers={providers}
        tools={tools}
        onClose={() => setFormOpen(false)}
        onSubmit={handleSubmit}
      />
    </div>
  )
}

export default AgentsPanel
