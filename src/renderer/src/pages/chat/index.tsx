import { useCallback, useEffect, useRef, useState } from 'react'
import { App, theme } from 'antd'
import type { Conversation, Message } from '../../../../main/chat/sql'
import type { AppSettings } from '../../../../main/store/types'
import Sidebar from './Sidebar'
import ChatPanel from './ChatPanel'
import SettingsModal from '../../components/SettingsModal'
import { useReplyStream } from '../../hooks/useReplyStream'

function ChatPage(): React.JSX.Element {
  const { message, modal } = App.useApp()
  const { token } = theme.useToken()

  const [conversations, setConversations] = useState<Conversation[]>([])
  // null 表示"新对话"草稿态:还没有会话,发送首条消息时再创建
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  // 从用户点击发送到模型回复结束(或失败)期间为 true
  const [sending, setSending] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [currentModel, setCurrentModel] = useState<string | undefined>()
  // 与 activeId 同步的 ref,供异步回调判断返回结果是否仍属于当前会话
  const activeIdRef = useRef<string | null>(null)

  const refreshConversations = useCallback(async (): Promise<void> => {
    const res = await window.api.chat.getAllConversations()
    if (res.success) {
      setConversations(res.data.conversations)
    } else {
      message.error(res.msg)
    }
  }, [message])

  const loadMessages = useCallback(
    async (conversationId: string): Promise<void> => {
      const res = await window.api.chat.getMessages(conversationId)
      // 请求期间用户已切换到别的会话,丢弃过期结果
      if (activeIdRef.current !== conversationId) return
      if (res.success) {
        setMessages(res.data.messages)
      } else {
        message.error(res.msg)
      }
    },
    [message]
  )

  // 回复结束后:当前会话则重拉消息拿到落库内容,并刷新会话排序
  const finishReply = useCallback(
    async (conversationId: string): Promise<void> => {
      if (activeIdRef.current === conversationId) {
        await loadMessages(conversationId)
      }
      await refreshConversations()
      setSending(false)
    },
    [loadMessages, refreshConversations]
  )

  const {
    streaming,
    start: startReply,
    abort: abortReply
  } = useReplyStream({
    onDone: finishReply,
    onError: async (conversationId, msg) => {
      message.error(msg)
      await finishReply(conversationId)
    }
  })

  const selectConversation = (conversationId: string): Promise<void> => {
    // 重复点击当前会话时不重新加载,避免列表闪烁
    if (activeIdRef.current === conversationId) return Promise.resolve()
    activeIdRef.current = conversationId
    setActiveId(conversationId)
    setMessages([])
    return loadMessages(conversationId)
  }

  const newConversation = (): void => {
    activeIdRef.current = null
    setActiveId(null)
    setMessages([])
  }

  // 读取设置里的模型列表和当前模型,返回完整设置供调用方使用
  const loadSettings = useCallback(async (): Promise<AppSettings> => {
    const settings = await window.api.settings.getAll()
    setModels(settings.models ?? [])
    setCurrentModel(settings.currentModel)
    return settings
  }, [])

  // 首次挂载:加载会话列表和设置;未配置 baseUrl 时自动打开设置页
  useEffect(() => {
    const init = async (): Promise<void> => {
      await refreshConversations()
      const settings = await loadSettings()
      if (!settings.baseUrl) {
        setSettingsOpen(true)
      }
    }
    void init()
  }, [refreshConversations, loadSettings])

  const handleModelChange = async (model: string): Promise<void> => {
    setCurrentModel(model)
    try {
      await window.api.settings.set('currentModel', model)
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSend = async (content: string): Promise<void> => {
    const text = content.trim()
    if (!text || sending) return
    if (!currentModel) {
      message.warning('请先选择模型')
      setSettingsOpen(true)
      return
    }
    setSending(true)
    try {
      // 1. 用户消息落库并刷新列表
      let conversationId = activeIdRef.current
      if (conversationId === null) {
        const res = await window.api.chat.sendFirstMessage({ content: text })
        if (!res.success) {
          message.error(res.msg)
          setSending(false)
          return
        }
        conversationId = res.data.conversationId
        await refreshConversations()
        await selectConversation(conversationId)
      } else {
        const res = await window.api.chat.sendMessage({ conversationId, content: text })
        if (!res.success) {
          message.error(res.msg)
          setSending(false)
          return
        }
        await Promise.all([loadMessages(conversationId), refreshConversations()])
      }
      // 2. 触发模型回复;成功后 sending 由流结束事件解除
      const started = await startReply(conversationId, currentModel)
      if (!started.success) {
        message.error(started.msg)
        setSending(false)
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
      setSending(false)
    }
  }

  const handleCancel = (): void => {
    void abortReply()
  }

  const handleRename = async (conversationId: string, title: string): Promise<void> => {
    const res = await window.api.chat.renameConversation({ conversationId, title })
    if (!res.success) {
      message.error(res.msg)
      return
    }
    await refreshConversations()
  }

  const handleDelete = (conversationId: string): void => {
    modal.confirm({
      title: '删除对话',
      content: '删除后该对话的全部消息将无法恢复,确定删除吗?',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async (): Promise<void> => {
        // 主进程会先中止该会话进行中的生成,随后的 done 事件会把 streaming 清空
        const res = await window.api.chat.removeConversation(conversationId)
        if (!res.success) {
          message.error(res.msg)
          return
        }
        if (activeIdRef.current === conversationId) {
          newConversation()
        }
        await refreshConversations()
      }
    })
  }

  return (
    <div style={{ display: 'flex', height: '100%', background: token.colorBgLayout }}>
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={selectConversation}
        onNew={newConversation}
        onRename={handleRename}
        onDelete={handleDelete}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <ChatPanel
        messages={messages}
        // 只把属于当前会话的流式内容交给面板,切走时不显示
        streaming={streaming?.conversationId === activeId ? streaming : null}
        isDraft={activeId === null}
        sending={sending}
        models={models}
        currentModel={currentModel}
        onSend={handleSend}
        onCancel={handleCancel}
        onModelChange={handleModelChange}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={loadSettings}
      />
    </div>
  )
}

export default ChatPage
