import { useEffect, useState } from 'react'
import { App, Button, Flex, List, Space, Tag, Typography, theme } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { v4 as uuidv4 } from 'uuid'
import type { ModelProvider, ModelProviderDraft, ModelRef } from '../../../../main/store/types'
import { normalizeRef } from '../../../../main/store/modelRef'
import ProviderFormDrawer from './ProviderFormDrawer'

/** 模型服务商管理:每个服务商一套 baseUrl / apiKey,下挂自己的模型清单 */
function ProvidersPanel(): React.JSX.Element {
  const { message, modal } = App.useApp()
  const { token } = theme.useToken()
  const [providers, setProviders] = useState<ModelProvider[]>([])
  const [currentRef, setCurrentRef] = useState<ModelRef | undefined>()
  const [formOpen, setFormOpen] = useState(false)
  // null = 新建
  const [formProvider, setFormProvider] = useState<ModelProvider | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.settings.getAll().then((settings) => {
      if (cancelled) return
      setProviders(settings.providers ?? [])
      setCurrentRef(settings.currentModel)
    })
    return (): void => {
      cancelled = true
    }
  }, [])

  /**
   * 服务商写回后必须把"当前选中的模型"一起收敛。
   * 否则删掉正在用的服务商、或改掉它的模型清单,都会留下悬空引用。
   */
  const persist = async (next: ModelProvider[]): Promise<void> => {
    await window.api.settings.set('providers', next)
    const normalized = normalizeRef(currentRef, next)
    if (
      normalized?.providerId !== currentRef?.providerId ||
      normalized?.model !== currentRef?.model
    ) {
      await window.api.settings.set('currentModel', normalized)
      setCurrentRef(normalized)
    }
    setProviders(next)
  }

  const handleSubmit = async (draft: ModelProviderDraft): Promise<boolean> => {
    const name = draft.name.trim()
    const duplicated = providers.some((p) => p.name === name && p.id !== formProvider?.id)
    if (duplicated) {
      message.error(`已有名为「${name}」的服务商`)
      return false
    }
    const provider: ModelProvider = {
      id: formProvider?.id ?? uuidv4(),
      name,
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey?.trim() || undefined,
      models: draft.models.filter(Boolean)
    }
    const next = formProvider
      ? providers.map((p) => (p.id === provider.id ? provider : p))
      : [...providers, provider]
    await persist(next)
    message.success(formProvider ? '已保存' : `已创建服务商 ${name}`)
    return true
  }

  const handleDelete = (provider: ModelProvider): void => {
    modal.confirm({
      title: '删除模型服务商',
      content: `将删除「${provider.name}」及其 ${provider.models.length} 个模型配置。若正在使用它,会自动切到其它可用模型。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async (): Promise<void> => {
        await persist(providers.filter((p) => p.id !== provider.id))
        message.success(`已删除 ${provider.name}`)
      }
    })
  }

  const activeId = currentRef?.providerId

  return (
    <div>
      <Flex align="center" justify="space-between" style={{ marginBottom: token.marginXS }}>
        <Typography.Text type="secondary">
          每个服务商一套接口地址与凭据,模型按服务商分组出现在聊天页的选择器里。
        </Typography.Text>
        <Button
          size="small"
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setFormProvider(null)
            setFormOpen(true)
          }}
        >
          新建服务商
        </Button>
      </Flex>

      {providers.length === 0 ? (
        <Typography.Paragraph type="secondary">
          还没有配置模型服务商。新建一个并填好 Base URL 与模型,就能在聊天页选择了。
        </Typography.Paragraph>
      ) : (
        <List
          size="small"
          dataSource={providers}
          renderItem={(provider) => (
            <List.Item
              actions={[
                <Button
                  key="edit"
                  size="small"
                  type="link"
                  onClick={() => {
                    setFormProvider(provider)
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
                  onClick={() => handleDelete(provider)}
                >
                  删除
                </Button>
              ]}
            >
              <List.Item.Meta
                title={
                  <Space wrap>
                    <span>{provider.name}</span>
                    {provider.id === activeId && <Tag color="blue">使用中</Tag>}
                    <Tag>{provider.models.length} 个模型</Tag>
                    {!provider.apiKey && <Tag>无 API Key</Tag>}
                  </Space>
                }
                description={
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {provider.baseUrl || '(未填写 Base URL)'}
                  </Typography.Text>
                }
              />
            </List.Item>
          )}
        />
      )}

      <ProviderFormDrawer
        open={formOpen}
        provider={formProvider}
        takenNames={providers.filter((p) => p.id !== formProvider?.id).map((p) => p.name)}
        onClose={() => setFormOpen(false)}
        onSubmit={handleSubmit}
      />
    </div>
  )
}

export default ProvidersPanel
