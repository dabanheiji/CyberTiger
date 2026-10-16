import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { App, theme } from 'antd'
import type { Conversation, Message } from '../../../../main/chat/sql'
import type { AppSettings, ModelProvider, ModelRef } from '../../../../main/store/types'
import { normalizeRef } from '../../../../main/store/modelRef'
import { compactResultLine } from '../../lib/contextUsage'
import { pushRecent } from '../../lib/workspace'
import Sidebar from './Sidebar'
import ChatPanel from './ChatPanel'
import { useAgentStream } from '../../hooks/useAgentStream'

function ChatPage(): React.JSX.Element {
  const { message, modal } = App.useApp()
  const { token } = theme.useToken()
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const [conversations, setConversations] = useState<Conversation[]>([])
  // null 表示"新对话"草稿态:还没有会话,发送首条消息时再创建
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  // 从用户点击发送到模型回复结束(或失败)期间为 true
  const [sending, setSending] = useState(false)
  const [providers, setProviders] = useState<ModelProvider[]>([])
  const [currentRef, setCurrentRef] = useState<ModelRef | undefined>()
  // 手动压缩在等 IPC 返回:按钮转圈,同时避免连点起两次压缩
  const [compacting, setCompacting] = useState(false)
  /** 草稿态待用的工作空间:首条消息建会话时由主进程抄进那一行 */
  const [defaultWorkspace, setDefaultWorkspace] = useState('')
  /** 最近用过的工作空间,最新在前;跨会话共享,所以放在设置里而不是会话行上 */
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([])
  // 与 activeId 同步的 ref,供异步回调判断返回结果是否仍属于当前会话
  const activeIdRef = useRef<string | null>(null)

  const openSettings = useCallback((): void => {
    navigate('/settings')
  }, [navigate])

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
  } = useAgentStream({
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
    const list = settings.providers ?? []
    setProviders(list)
    // 服务商被删、模型被移出清单时收敛到一个可用值,避免选择器停在悬空引用上
    setCurrentRef(normalizeRef(settings.currentModel, list))
    setDefaultWorkspace(settings.defaultWorkspace ?? '')
    setRecentWorkspaces(settings.workspaceRecent ?? [])
    return settings
  }, [])

  // 首次挂载:加载会话列表和设置;未配置 baseUrl 时自动进入设置页
  useEffect(() => {
    const init = async (): Promise<void> => {
      await refreshConversations()
      const settings = await loadSettings()
      // 一个服务商都没配过:直接把人带到设置页
      if ((settings.providers ?? []).length === 0) {
        openSettings()
      }
    }
    void init()
  }, [refreshConversations, loadSettings, openSettings])

  // 从设置页返回时重新读取模型列表,反映刚保存的改动
  useEffect(() => {
    if (pathname === '/') void loadSettings()
  }, [pathname, loadSettings])

  const handleModelChange = async (ref: ModelRef): Promise<void> => {
    setCurrentRef(ref)
    try {
      await window.api.settings.set('currentModel', ref)
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * 把当前会话(或草稿)的工作空间换成 dir,空串即清除。
   *
   * 两条写路径必须分开:已有会话写 conversations.workspace,草稿态只能写全局的
   * defaultWorkspace —— 那时还没有会话行可写。写错的表现是"选了但工具没跟着变",
   * 所以按 activeIdRef 现读现判,而不是用可能过期的闭包值。
   * 最近列表是跨会话的偏好,两边都往 settings.workspaceRecent 记一笔。
   */
  const applyWorkspace = async (dir: string): Promise<void> => {
    const conversationId = activeIdRef.current
    if (conversationId === null) {
      setDefaultWorkspace(dir)
      await window.api.settings.set('defaultWorkspace', dir)
    } else {
      const res = await window.api.chat.setWorkspace({ conversationId, dir })
      if (!res.success) {
        message.error(res.msg)
        return
      }
      await refreshConversations()
    }
    if (!dir) return
    const next = pushRecent(recentWorkspaces, dir)
    setRecentWorkspaces(next)
    await window.api.settings.set('workspaceRecent', next)
  }

  const handlePickWorkspace = async (): Promise<void> => {
    const res = await window.api.chat.pickWorkspace()
    if (!res.success) {
      message.error(res.msg)
      return
    }
    // 取消对话框:data 为 null,什么都不改
    if (res.data === null) return
    await applyWorkspace(res.data)
  }

  const handleClearWorkspace = async (): Promise<void> => {
    await applyWorkspace('')
  }

  /**
   * 组标题上的「+」:在该组的工作空间下新开会话。
   *
   * 走草稿态那条写路径 —— newConversation() 先把 activeIdRef 归 null,applyWorkspace
   * 才会写 settings.defaultWorkspace 而不是去改某个已有会话的行;首条消息发出去时由
   * 主进程把待用值抄进新建的那一行。不当场建会话行:点一下「+」就多出一条空对话,
   * 用户往往只是看看,列表却被写脏。
   */
  const newConversationInWorkspace = async (dir: string): Promise<void> => {
    newConversation()
    await applyWorkspace(dir)
  }

  /** 当前显示的工作空间:草稿用待用值,已建会话用那一行自己记的 */
  const activeWorkspace =
    activeId === null
      ? defaultWorkspace
      : (conversations.find((c) => c.id === activeId)?.workspace ?? '')

  const handleSend = async (content: string, skillName?: string): Promise<void> => {
    const text = content.trim()
    if (!text || sending) return
    if (!currentRef) {
      message.warning('请先选择模型')
      openSettings()
      return
    }
    setSending(true)
    try {
      // 1. 用户消息落库并刷新列表
      let conversationId = activeIdRef.current
      if (conversationId === null) {
        const res = await window.api.chat.sendFirstMessage({ content: text, skill: skillName })
        if (!res.success) {
          message.error(res.msg)
          setSending(false)
          return
        }
        conversationId = res.data.conversationId
        await refreshConversations()
        await selectConversation(conversationId)
      } else {
        const res = await window.api.chat.sendMessage({
          conversationId,
          content: text,
          skill: skillName
        })
        if (!res.success) {
          message.error(res.msg)
          setSending(false)
          return
        }
        await Promise.all([loadMessages(conversationId), refreshConversations()])
      }
      // 2. 触发模型回复;成功后 sending 由流结束事件解除
      const started = await startReply(conversationId, currentRef)
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

  /**
   * 把用户的选择交回主进程:那边正阻塞在同一次 ask_user 工具调用上,答案到手这一轮才继续。
   * 卡片的收起交给同一次调用的 tool_result 事件,这里只负责送答案 —— 送不出去时(提问已
   * 了结)把原因说清就好,静默失败看起来像按钮没反应。
   */
  const handleAnswerQuestion = async (answers: string[]): Promise<void> => {
    const pending = streaming?.pendingQuestion
    if (!pending) return
    const res = await window.api.chat.answerQuestion({
      questionId: pending.questionId,
      answers
    })
    if (!res.success) message.error(res.msg)
  }

  /**
   * 提问也可能来自后台会话(切换会话不影响正在跑的 run)。
   * 卡片只在当前会话显示,所以那边在等的时候提一句是哪个对话,否则用户只看到一个
   * 转圈的停止按钮,却不知道这一轮卡在谁那儿。每个问题只提一次。
   */
  const warnedQuestionRef = useRef('')
  useEffect(() => {
    const pending = streaming?.pendingQuestion
    if (!pending || !streaming || pending.questionId === warnedQuestionRef.current) return
    warnedQuestionRef.current = pending.questionId
    if (streaming.conversationId === activeIdRef.current) return
    const title =
      conversations.find((c) => c.id === streaming.conversationId)?.title ?? '另一个对话'
    message.warning(`「${title}」在等你回答`)
  }, [streaming, conversations, message])

  /**
   * 手动压缩当前会话的上下文。
   *
   * 压没压都要说一句:被计划拒绝时(可压的太少 / 省不出空间)用户点这颗按钮就是为了
   * 知道为什么没压,静默返回等于什么都没发生。结论只在这一句提示里说,不占用环。
   */
  const handleCompact = async (): Promise<void> => {
    if (activeId === null || !currentRef || compacting) return
    setCompacting(true)
    try {
      const res = await window.api.chat.compactContext({
        conversationId: activeId,
        providerId: currentRef.providerId,
        model: currentRef.model
      })
      if (!res.success) {
        message.error(res.msg)
        return
      }
      if (res.data.compacted) {
        message.success(compactResultLine(res.data))
      } else {
        message.warning(compactResultLine(res.data))
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setCompacting(false)
    }
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

  /** 只把属于当前会话的流式内容交给面板,切走时不显示 */
  const shownRun = streaming?.conversationId === activeId ? streaming : null

  return (
    <div style={{ display: 'flex', height: '100%', background: token.colorBgLayout }}>
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={selectConversation}
        onNew={newConversation}
        onNewInWorkspace={(dir) => void newConversationInWorkspace(dir)}
        onRename={handleRename}
        onDelete={handleDelete}
        onOpenSettings={openSettings}
      />
      <ChatPanel
        messages={messages}
        streaming={shownRun}
        pendingQuestion={shownRun?.pendingQuestion ?? null}
        isDraft={activeId === null}
        sending={sending}
        providers={providers}
        currentRef={currentRef}
        compacting={compacting}
        workspace={activeWorkspace}
        recentWorkspaces={recentWorkspaces}
        onSend={handleSend}
        onCancel={handleCancel}
        onAnswerQuestion={(answers) => void handleAnswerQuestion(answers)}
        onCompact={() => void handleCompact()}
        onModelChange={handleModelChange}
        onOpenSettings={openSettings}
        onPickWorkspace={() => void handlePickWorkspace()}
        onSelectWorkspace={(dir) => void applyWorkspace(dir)}
        onClearWorkspace={() => void handleClearWorkspace()}
      />
    </div>
  )
}

export default ChatPage
