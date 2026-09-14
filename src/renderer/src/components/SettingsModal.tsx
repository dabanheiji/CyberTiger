import { useEffect, useState } from 'react'
import { App, Button, Flex, Form, Input, Modal } from 'antd'
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons'

interface SettingsFormValues {
  baseUrl: string
  apiKey?: string
  models?: string[]
}

interface SettingsModalProps {
  open: boolean
  onClose: () => void
  /** 保存成功后回调，供外层重新读取设置 */
  onSaved?: () => void
}

function SettingsModal({ open, onClose, onSaved }: SettingsModalProps): React.JSX.Element {
  const { message } = App.useApp()
  const [form] = Form.useForm<SettingsFormValues>()
  const [saving, setSaving] = useState(false)

  // 每次打开时读取当前配置回填到表单
  useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    window.api.settings.getAll().then((settings) => {
      if (cancelled) return
      form.setFieldsValue({
        baseUrl: settings.baseUrl ?? '',
        apiKey: settings.apiKey ?? '',
        models: settings.models ?? []
      })
    })
    return (): void => {
      cancelled = true
    }
  }, [open, form])

  // 模型 ID 不允许重复
  const validateUniqueModel = (_rule: unknown, value: string): Promise<void> => {
    const list: string[] = form.getFieldValue('models') ?? []
    const id = value?.trim()
    if (id && list.filter((m) => m?.trim() === id).length > 1) {
      return Promise.reject(new Error('模型 ID 重复'))
    }
    return Promise.resolve()
  }

  const handleOk = async (): Promise<void> => {
    // 校验未通过时 Form 已在字段下方给出提示，这里直接返回
    const values = await form.validateFields().catch(() => null)
    if (!values) return
    const models = (values.models ?? []).map((m) => m.trim())
    setSaving(true)
    try {
      const { settings } = window.api
      await settings.set('baseUrl', values.baseUrl.trim())
      await settings.set('apiKey', (values.apiKey ?? '').trim())
      await settings.set('models', models)
      // 当前选中的模型被删掉时回退到列表第一项；列表为空则清除
      const current = await settings.get('currentModel')
      const next = current && models.includes(current) ? current : models[0]
      if (next) {
        await settings.set('currentModel', next)
      } else if (current) {
        await settings.remove('currentModel')
      }
      message.success('设置已保存')
      onSaved?.()
      onClose()
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="设置"
      open={open}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      onOk={handleOk}
      onCancel={onClose}
      destroyOnHidden
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="baseUrl"
          label="Base URL"
          extra="OpenAI 兼容接口地址，例如 https://api.openai.com/v1"
          rules={[
            { required: true, whitespace: true, message: '请输入 Base URL' },
            { type: 'url', message: '请输入合法的 URL' }
          ]}
        >
          <Input autoFocus placeholder="https://api.openai.com/v1" />
        </Form.Item>
        <Form.Item name="apiKey" label="API Key">
          <Input.Password placeholder="sk-..." />
        </Form.Item>
        <Form.Item label="模型列表" extra="填写模型 ID，例如 qwen3.5:4b 或 deepseek-v4-flash">
          <Form.List name="models">
            {(fields, { add, remove }) => (
              <Flex vertical gap="small">
                {fields.map((field) => (
                  <Flex key={field.key} gap="small" align="start">
                    <Form.Item
                      name={field.name}
                      rules={[
                        { required: true, whitespace: true, message: '请输入模型 ID' },
                        { validator: validateUniqueModel }
                      ]}
                      style={{ flex: 1, marginBottom: 0 }}
                    >
                      <Input placeholder="例如 qwen3.5:4b" />
                    </Form.Item>
                    <Button
                      type="text"
                      aria-label="删除模型"
                      icon={<MinusCircleOutlined />}
                      onClick={() => remove(field.name)}
                    />
                  </Flex>
                ))}
                <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add('')}>
                  添加模型
                </Button>
              </Flex>
            )}
          </Form.List>
        </Form.Item>
      </Form>
    </Modal>
  )
}

export default SettingsModal
