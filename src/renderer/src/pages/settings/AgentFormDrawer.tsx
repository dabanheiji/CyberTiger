import { useEffect, useState } from 'react'
import { Button, Drawer, Form, Input, Select, Space, Typography } from 'antd'
import type { AgentDraft, AgentMeta, AgentToolOption } from '../../../../main/agents/types'
import type { ModelProvider } from '../../../../main/store/types'
import { modelKey, parseModelKey } from '../../lib/modelRef'

/** 表单内的模型字段用复合键(服务商 id + 模型名),提交时再翻译成服务商名字 */
interface AgentFormValues extends Omit<AgentDraft, 'provider' | 'model'> {
  modelKey?: string
}

interface AgentFormDrawerProps {
  open: boolean
  /** null 表示新建,否则为正在编辑的角色 */
  agent: AgentMeta | null
  /** 已配置的服务商,用于按服务商分组选模型 */
  providers: ModelProvider[]
  /** 工具白名单候选 */
  tools: AgentToolOption[]
  onClose: () => void
  /** 返回是否保存成功;成功时由本组件负责关闭 */
  onSubmit: (draft: AgentDraft) => Promise<boolean>
}

/** 角色名规则与主进程 parseAgentFile 保持一致,避免前端放过、后端才报错 */
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
/** 内置通用角色的名字,不允许自定义角色占用 */
const RESERVED_NAMES = ['generic']

function AgentFormDrawer({
  open,
  agent,
  providers,
  tools,
  onClose,
  onSubmit
}: AgentFormDrawerProps): React.JSX.Element {
  const [form] = Form.useForm<AgentFormValues>()
  const [saving, setSaving] = useState(false)

  // 每次打开都用当前角色(或空表单)重置,避免残留上一次的输入
  useEffect(() => {
    if (!open) return
    // 存的是服务商名字,界面里用 id;解析不到就留空,保存时原样保留(见 handleOk)
    const provider = agent?.provider ? providers.find((p) => p.name === agent.provider) : undefined
    form.setFieldsValue({
      name: agent?.name ?? '',
      description: agent?.description ?? '',
      systemPrompt: agent?.systemPrompt ?? '',
      modelKey:
        provider && agent?.model
          ? modelKey({ providerId: provider.id, model: agent.model })
          : undefined,
      tools: agent?.tools
    })
  }, [open, agent, providers, form])

  const handleOk = async (): Promise<void> => {
    let draft: AgentFormValues
    try {
      draft = await form.validateFields()
    } catch {
      return
    }
    // 选了模型就按选择走;没选则原样保留角色里已有的 provider / model,
    // 避免"打开看一眼再保存"把原本解析不到的值悄悄抹掉
    const picked = draft.modelKey ? parseModelKey(draft.modelKey) : undefined
    const pickedProvider = picked ? providers.find((p) => p.id === picked.providerId) : undefined
    const next: AgentDraft = {
      name: draft.name,
      description: draft.description,
      systemPrompt: draft.systemPrompt,
      provider: pickedProvider?.name ?? agent?.provider,
      model: picked?.model ?? agent?.model,
      tools: draft.tools
    }

    setSaving(true)
    try {
      if (await onSubmit(next)) onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer
      open={open}
      title={agent ? `编辑角色:${agent.name}` : '新建子 Agent 角色'}
      width={560}
      onClose={onClose}
      destroyOnHidden
      footer={
        <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={handleOk}>
            保存
          </Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical" requiredMark="optional">
        <Form.Item
          name="name"
          label="角色名"
          extra={
            agent
              ? '改名会同时重命名该角色的目录;主 Agent 通过这个名字选用角色。'
              : '只能用小写字母、数字和连字符;主 Agent 通过这个名字选用角色。'
          }
          rules={[
            { required: true, message: '请填写角色名' },
            { max: 64, message: '不能超过 64 个字符' },
            {
              pattern: NAME_PATTERN,
              message: '只能包含小写字母、数字和连字符,不能以连字符开头/结尾'
            },
            {
              validator: (_rule, value: string) =>
                RESERVED_NAMES.includes(value)
                  ? Promise.reject(new Error('该名称已被内置角色占用'))
                  : Promise.resolve()
            }
          ]}
        >
          <Input placeholder="例如 researcher" />
        </Form.Item>

        <Form.Item
          name="description"
          label="描述"
          extra="主 Agent 靠这句话判断什么时候该派这个角色,写清适用场景。"
          rules={[
            { required: true, message: '请填写描述' },
            { max: 1024, message: '不能超过 1024 个字符' }
          ]}
        >
          <Input.TextArea
            autoSize={{ minRows: 2, maxRows: 4 }}
            placeholder="需要在多个来源之间交叉验证事实时使用"
          />
        </Form.Item>

        <Form.Item
          name="systemPrompt"
          label="System Prompt"
          extra="该角色的完整指令,子 Agent 只能看到这段指令与主 Agent 给的任务说明。"
          rules={[{ required: true, message: '请填写 system prompt' }]}
        >
          <Input.TextArea
            autoSize={{ minRows: 6, maxRows: 16 }}
            placeholder="你是一名严谨的研究员……"
          />
        </Form.Item>

        <Form.Item
          name="modelKey"
          label="模型"
          extra="留空则继承主 Agent 当前使用的服务商与模型;选了别的服务商就会跨过去调用。"
        >
          <Select
            allowClear
            placeholder="继承父级模型"
            popupMatchSelectWidth={false}
            options={providers
              .filter((p) => p.models.length > 0)
              .map((p) => ({
                label: p.name,
                options: p.models.map((model) => ({
                  value: modelKey({ providerId: p.id, model }),
                  label: model
                }))
              }))}
            labelRender={({ value }) => {
              if (value === undefined) return ''
              const ref = parseModelKey(String(value))
              const provider = providers.find((p) => p.id === ref.providerId)
              return provider ? `${provider.name} · ${ref.model}` : ref.model
            }}
          />
        </Form.Item>

        <Form.Item
          name="tools"
          label="可用工具"
          extra="留空则继承主 Agent 的全部工具(子 Agent 始终无法派生子 Agent)。"
        >
          <Select
            mode="multiple"
            allowClear
            placeholder="继承全部工具"
            optionFilterProp="label"
            options={tools.map((t) => ({
              value: t.name,
              label: t.name,
              title: t.description
            }))}
            optionRender={(option) => {
              const tool = tools.find((t) => t.name === option.value)
              return (
                <Space>
                  <span>{option.value}</span>
                  {tool && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {tool.source}
                    </Typography.Text>
                  )}
                </Space>
              )
            }}
          />
        </Form.Item>
      </Form>
    </Drawer>
  )
}

export default AgentFormDrawer
