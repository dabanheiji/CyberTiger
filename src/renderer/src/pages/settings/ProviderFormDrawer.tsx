import { useEffect, useState } from 'react'
import { Button, Drawer, Form, Input, Space, Typography } from 'antd'
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons'
import type { ModelProvider, ModelProviderDraft } from '../../../../main/store/types'

interface ProviderFormDrawerProps {
  open: boolean
  /** null 表示新建,否则为正在编辑的服务商 */
  provider: ModelProvider | null
  /** 其它服务商已占用的名字,用于唯一性校验(不含自己) */
  takenNames: string[]
  onClose: () => void
  /** 返回是否保存成功;成功时由本组件负责关闭 */
  onSubmit: (draft: ModelProviderDraft) => Promise<boolean>
}

/** 服务商名要唯一:AGENT.md 里就是靠这个名字引用服务商的 */
function ProviderFormDrawer({
  open,
  provider,
  takenNames,
  onClose,
  onSubmit
}: ProviderFormDrawerProps): React.JSX.Element {
  const [form] = Form.useForm<ModelProviderDraft>()
  const [saving, setSaving] = useState(false)

  // 每次打开都用当前服务商(或空表单)重置,避免残留上一次的输入
  useEffect(() => {
    if (!open) return
    form.setFieldsValue({
      name: provider?.name ?? '',
      baseUrl: provider?.baseUrl ?? '',
      apiKey: provider?.apiKey ?? '',
      models: provider?.models.length ? provider.models : ['']
    })
  }, [open, provider, form])

  const handleOk = async (): Promise<void> => {
    let draft: ModelProviderDraft
    try {
      draft = await form.validateFields()
    } catch {
      return
    }
    setSaving(true)
    try {
      if (await onSubmit({ ...draft, models: (draft.models ?? []).map((m) => m.trim()) })) {
        onClose()
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer
      open={open}
      title={provider ? `编辑服务商:${provider.name}` : '新建模型服务商'}
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
          label="名称"
          extra={
            provider
              ? '用于在选择器里分组。改名后,按旧名字引用它的子 Agent 角色会自动回退到主 Agent 的服务商。'
              : '用于在选择器里分组,也是子 Agent 角色引用服务商时用的名字。'
          }
          rules={[
            { required: true, whitespace: true, message: '请填写名称' },
            { max: 40, message: '不能超过 40 个字符' },
            {
              validator: (_rule, value: string) =>
                value && takenNames.includes(value.trim())
                  ? Promise.reject(new Error('已有同名服务商'))
                  : Promise.resolve()
            }
          ]}
        >
          <Input placeholder="例如 本地 Ollama" />
        </Form.Item>

        <Form.Item
          name="baseUrl"
          label="Base URL"
          extra="OpenAI 兼容接口地址,例如 https://api.deepseek.com/v1"
          rules={[
            { required: true, whitespace: true, message: '请输入 Base URL' },
            { type: 'url', message: '请输入合法的 URL' }
          ]}
        >
          <Input placeholder="https://api.deepseek.com/v1" />
        </Form.Item>

        <Form.Item name="apiKey" label="API Key" extra="本地服务(Ollama / vLLM)留空即可。">
          <Input.Password placeholder="sk-..." />
        </Form.Item>

        <Form.Item label="模型列表" extra="这里是选择器里的候选清单,填服务端支持的模型 ID 即可。">
          <Form.List name="models">
            {(fields, { add, remove }) => (
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                {fields.map((field) => (
                  <Space key={field.key} align="start" style={{ width: '100%' }}>
                    <Form.Item
                      name={field.name}
                      rules={[
                        { required: true, whitespace: true, message: '请输入模型 ID' },
                        {
                          validator: (_rule, value: string) => {
                            const list: string[] = form.getFieldValue('models') ?? []
                            const id = value?.trim()
                            if (id && list.filter((m) => m?.trim() === id).length > 1) {
                              return Promise.reject(new Error('模型 ID 重复'))
                            }
                            return Promise.resolve()
                          }
                        }
                      ]}
                      style={{ flex: 1, marginBottom: 0, minWidth: 320 }}
                    >
                      <Input placeholder="例如 deepseek-chat" />
                    </Form.Item>
                    <Button
                      type="text"
                      aria-label="删除模型"
                      icon={<MinusCircleOutlined />}
                      onClick={() => remove(field.name)}
                    />
                  </Space>
                ))}
                <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add('')}>
                  添加模型
                </Button>
              </Space>
            )}
          </Form.List>
        </Form.Item>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          模型清单只是候选,不做白名单校验 —— 服务端支持什么由服务端决定。
        </Typography.Text>
      </Form>
    </Drawer>
  )
}

export default ProviderFormDrawer
