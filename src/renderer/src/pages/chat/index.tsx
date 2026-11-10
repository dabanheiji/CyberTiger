import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { App, theme } from 'antd'
import type { Conversation, Message } from '../../../../main/chat/sql'
import type { ApprovalOutcome, PendingPlanDto } from '../../../../main/chat/dto'
import type {
  AppSettings,
  ModelProvider,
  ModelRef,
  PermissionSettings
} from '../../../../main/store/types'
import { normalizeRef } from '../../../../main/store/modelRef'
import { compactResultLine } from '../../lib/contextUsage'
import { commandBlockedReason } from '../../lib/chatCommands'
import { pushRecent } from '../../lib/workspace'
import Sidebar from './Sidebar'
import ChatPanel from './ChatPanel'
import ErrorBoundary from '../../components/ErrorBoundary'
import { useAgentStream } from '../../hooks/useAgentStream'

interface ChatPageProps {
  /** 全局权限设置(档位 + 名单);真值在 App,写入也经 App 下传的那颗 setter */
  permissions: PermissionSettings
  onPermissionsChange: (next: PermissionSettings) => void
}

/**
 * 会话标题,取不到时给一句不指名的说法。
 * 「在等你回答」与「在等你审批」两句共用;做成模块级纯函数是为了不进任何 effect 的依赖数组。
 */
function titleOf(conversations: Conversation[], conversationId: string): string {
  return conversations.find((c) => c.id === conversationId)?.title ?? '另一个对话'
}

function ChatPage({ permissions, onPermissionsChange }: ChatPageProps): React.JSX.Element {
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
  // 与 compacting 同义,但挡的是同帧重复触发 —— 回车连击、菜单点击与回车同时到达时,
  // state 还没提交,只看 compacting 会让两次都放过去
  const compactingRef = useRef(false)
  /** 计划模式:消息先交给 plan-agent 出计划,审批后才真正执行 */
  const [planMode, setPlanMode] = useState(false)
  /** 当前会话待审批的那份计划;从库里派生,批准 / 放弃 / 发下一句后自动消失 */
  const [pendingPlan, setPendingPlan] = useState<PendingPlanDto | null>(null)
  /** 草稿态待用的工作空间:首条消息建会话时由主进程抄进那一行 */
  const [defaultWorkspace, setDefaultWorkspace] = useState('')
  /** 最近用过的工作空间,最新在前;跨会话共享,所以放在设置里而不是会话行上 */
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([])
  // 与 activeId 同步的 ref,供异步回调判断返回结果是否仍属于当前会话
  const activeIdRef = useRef<string | null>(null)

  const openSettings = useCallback((): void => {
    navigate('/settings')
  }, [navigate])

  const openReport = useCallback((): void => {
    navigate('/report')
  }, [navigate])

  /**
   * 审批卡片上那个「加入白名单」:直接落到设置页的「权限」那一栏。
   * 只跳转不就地写名单 —— 名单有一处编辑面就够,两处会互相盖。
   */
  const openPermissionSettings = useCallback((): void => {
    navigate('/settings?tab=permission')
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

  /**
   * 重读当前会话待审批的计划。
   * 计划不另存状态:它就是「最后一条 user 行之后、plan-agent 落的那条纯正文 assistant 行」,
   * 所以生成结束、批准、放弃、发下一句之后都靠这一次派生把卡片对齐。
   */
  const refreshPendingPlan = useCallback(async (conversationId: string): Promise<void> => {
    if (!conversationId) return
    const res = await window.api.chat.pendingPlan(conversationId)
    // 请求期间用户已切走:丢弃过期结果
    if (activeIdRef.current !== conversationId) return
    if (res.success) setPendingPlan(res.data)
  }, [])

  // 回复结束后:当前会话则重拉消息拿到落库内容,并刷新会话排序
  const finishReply = useCallback(
    async (conversationId: string): Promise<void> => {
      if (activeIdRef.current === conversationId) {
        await loadMessages(conversationId)
        // 规划 run 的最终回答就是待审批的计划;执行 run 结束后也可能还剩旧草稿需要对齐
        await refreshPendingPlan(conversationId)
      }
      await refreshConversations()
      setSending(false)
    },
    [loadMessages, refreshPendingPlan, refreshConversations]
  )

  const {
    streaming,
    detachedApproval,
    detachedQuestion,
    start: startReply,
    startPlan,
    startRevision,
    track,
    abort: abortReply,
    refreshApprovals,
    refreshQuestions
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

  /**
   * 用户从侧栏切换会话:计划模式与待审批卡片都只属于原来那条会话,换过去就复位。
   * 新建会话(including 首条消息建出来的那条)走 `selectConversation` 本身,不复位 ——
   * 计划模式正是从「一句需求 + 新会话」开始的。
   */
  const handleSelectConversation = (conversationId: string): void => {
    setPlanMode(false)
    setPendingPlan(null)
    void selectConversation(conversationId)
  }

  const newConversation = (): void => {
    activeIdRef.current = null
    setActiveId(null)
    setMessages([])
    setPlanMode(false)
    setPendingPlan(null)
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
   * 换权限档位(卡片上的「加入白名单」跳到设置页,名单在那里改)。
   *
   * 先更新 App 那一份状态再写 store:`settings:*` 只有 pull 没有 push,
   * 界面若等一次回读才更新,底栏那颗就会在一次点击之后停在旧档位上。
   * 主进程侧下一轮 run 读到的就是这个键;正在跑的那一轮按「收紧立即、放宽下一轮」处理。
   */
  const handlePermissionChange = async (next: PermissionSettings): Promise<void> => {
    onPermissionsChange(next)
    try {
      await window.api.settings.set('permissions', next)
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

  /**
   * 把一条用户消息落库(草稿态先建会话),返回会话 id;失败时已经报过错了,返回 null。
   * 普通回复与计划请求共用这一段:两条路只是「落库之后发给谁」不同。
   */
  const persistUserMessage = async (text: string, skillName?: string): Promise<string | null> => {
    const conversationId = activeIdRef.current
    if (conversationId === null) {
      const res = await window.api.chat.sendFirstMessage({ content: text, skill: skillName })
      if (!res.success) {
        message.error(res.msg)
        return null
      }
      await refreshConversations()
      await selectConversation(res.data.conversationId)
      return res.data.conversationId
    }
    const res = await window.api.chat.sendMessage({
      conversationId,
      content: text,
      skill: skillName
    })
    if (!res.success) {
      message.error(res.msg)
      return null
    }
    await Promise.all([loadMessages(conversationId), refreshConversations()])
    return conversationId
  }

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
      const conversationId = await persistUserMessage(text, skillName)
      if (conversationId === null) {
        setSending(false)
        return
      }
      // 2. 计划模式下这次消息交给 plan-agent 出计划;否则照常触发主 Agent 回复。
      // 成功后 sending 由流结束事件解除
      if (planMode) {
        // 新需求让旧草稿失效:不必等派生刷新,先把卡片收掉
        setPendingPlan(null)
      }
      const started = planMode
        ? await startPlan(conversationId, currentRef)
        : await startReply(conversationId, currentRef)
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

  /** 只把属于当前会话的流式内容交给面板,切走时不显示 */
  const shownRun = streaming?.conversationId === activeId ? streaming : null

  /**
   * 当前会话要显示的提问:与审批同一条优先级 —— 正在跟踪的那一轮优先,
   * 其次是从主进程等待表拉回来的那条(`detachedQuestion`,典型场景是渲染层重载:
   * 订阅是新的、流式状态归零,而主进程还阻塞在那次 ask_user 调用上)。
   */
  const shownQuestion = shownRun?.pendingQuestion ?? detachedQuestion

  /**
   * 当前会话要显示的审批请求:优先正在跟踪的那一轮,其次是从主进程等待表拉回来的那条
   * (`detachedApproval` 只在「这一条属于当前显示的会话、但界面已经不在跟那个 run」时有值,
   * 典型场景是渲染层重载 —— 订阅是新的、流式状态归零,而主进程还阻塞在那次工具调用上)。
   */
  const shownApproval = shownRun?.pendingApproval ?? detachedApproval

  /**
   * 把用户的选择交回主进程:那边正阻塞在同一次 ask_user 工具调用上,答案到手这一轮才继续。
   * 卡片的收起交给同一次调用的 tool_result 事件,这里只负责送答案 —— 送不出去时(提问已
   * 了结)把原因说清就好,静默失败看起来像按钮没反应。
   *
   * 送完一定重读一次等待表,理由与审批那条相同:成功时不必等 tool_result,失败时
   * (刚超时 / 刚被中止)更要据此收卡,否则卡片会留在一个再也送不出去的选择上。
   */
  const handleAnswerQuestion = async (answers: string[]): Promise<void> => {
    if (!shownQuestion) return
    const res = await window.api.chat.answerQuestion({
      questionId: shownQuestion.questionId,
      answers
    })
    if (!res.success) message.error(res.msg)
    await refreshQuestions(activeIdRef.current ?? '')
  }

  /**
   * 把用户的决定交回主进程:那边正阻塞在同一次工具调用上,决定到手这一轮才继续。
   *
   * 送完一定重读一次等待表。成功时不必等那次 tool_result(等待表里已经没这条,卡片该立刻收),
   * 失败时(id 已失效 —— 刚超时、刚被中止,或渲染层重载期间用户按了两次)更要重读,
   * 否则卡片会留在一个再也送不出去的决定上。
   */
  const handleDecideApproval = async (outcome: ApprovalOutcome, reason: string): Promise<void> => {
    if (!shownApproval) return
    const res = await window.api.chat.decideApproval({
      approvalId: shownApproval.approvalId,
      outcome,
      ...(reason ? { reason } : {})
    })
    if (!res.success) message.error(res.msg)
    await refreshApprovals(activeIdRef.current ?? '')
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
    message.warning(`「${titleOf(conversations, streaming.conversationId)}」在等你回答`)
  }, [streaming, conversations, message])

  /**
   * 审批在等的提示与提问同一条:每个请求只提一次。
   * 差别在于审批更急 —— 窗口没在前台时主进程还会发一条系统通知,那是同一件事的另一面。
   */
  const warnedApprovalRef = useRef('')
  useEffect(() => {
    const pending = streaming?.pendingApproval
    if (!pending || !streaming || pending.approvalId === warnedApprovalRef.current) return
    warnedApprovalRef.current = pending.approvalId
    if (streaming.conversationId === activeIdRef.current) return
    message.warning(`「${titleOf(conversations, streaming.conversationId)}」在等你审批`)
  }, [streaming, conversations, message])

  /**
   * 挂载与切会话时重读主进程的审批等待表。
   *
   * 渲染层重载(Cmd+R)之后事件订阅是全新的、流式状态也归零,而主进程仍阻塞在那次工具调用上:
   * 不拉这一次,界面上就没有任何地方能回答它,那一轮连同这个会话一起卡死(切目录与手动压缩都进不去)。
   */
  useEffect(() => {
    void refreshApprovals(activeId ?? '')
    void refreshQuestions(activeId ?? '')
    if (!activeId) return
    // 待审批计划与审批同一形状:重载 / 切会话之后靠一次派生把卡片填回来。
    // 切换会话时的清空在 `handleSelectConversation` / `newConversation` 里做;这里走
    // `.then` 回调而不是直接调 `refreshPendingPlan` —— effect 体内同步触发 setState
    // 会招来 lint 的级联渲染告警,而这次读取本来就是异步的。
    let cancelled = false
    void window.api.chat.pendingPlan(activeId).then((res) => {
      if (cancelled || activeIdRef.current !== activeId) return
      if (res.success) setPendingPlan(res.data)
    })
    return () => {
      cancelled = true
    }
  }, [activeId, refreshApprovals, refreshQuestions])

  /**
   * 手动压缩当前会话的上下文。
   *
   * 压没压都要说一句:被计划拒绝时(可压的太少 / 省不出空间)用户点这颗按钮就是为了
   * 知道为什么没压,静默返回等于什么都没发生。结论只在这一句提示里说,不占用环。
   */
  const handleCompact = async (): Promise<void> => {
    // 压缩的两条入口(占用环按钮与 /compact)共用这一份理由,菜单里写的是同一句
    const reason = commandBlockedReason('compact', {
      hasConversation: activeId !== null,
      hasModel: !!currentRef,
      sending,
      compacting: compactingRef.current
    })
    if (reason) {
      message.warning(reason)
      return
    }
    // 上面那道守卫已经排除这两种情况,这里只为类型收窄
    if (activeId === null || !currentRef) return
    compactingRef.current = true
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
      compactingRef.current = false
      setCompacting(false)
    }
  }

  /**
   * `/` 菜单里选中或敲完整条命令后的统一入口。
   * 门禁与菜单的 disabled 说明共用 `commandBlockedReason`,两处不会各说一套。
   */
  const handleCommand = (name: string): void => {
    const reason = commandBlockedReason(name, {
      hasConversation: activeId !== null,
      hasModel: !!currentRef,
      sending,
      compacting: compactingRef.current
    })
    if (reason) {
      message.warning(reason)
      return
    }
    if (name === 'compact') {
      void handleCompact()
      return
    }
    if (name === 'plan') {
      const next = !planMode
      setPlanMode(next)
      message.info(
        next ? '已进入计划模式:消息先交给 plan-agent 生成计划,批准后才开始改代码' : '已退出计划模式'
      )
    }
  }

  /**
   * 批准待审批的计划:落盘 + 启动执行 run。
   *
   * 返回的 runId 交给 `track` 接管这一轮的流式状态 —— 与其它 run 一样,
   * 主进程那边的事件不带任何「这是计划执行」的特殊标记,只是同一套事件。
   */
  const handleApprovePlan = async (): Promise<void> => {
    const conversationId = activeIdRef.current
    if (conversationId === null || !currentRef) return
    setSending(true)
    try {
      const res = await window.api.chat.approvePlan({
        conversationId,
        providerId: currentRef.providerId,
        model: currentRef.model
      })
      if (!res.success) {
        message.error(res.msg)
        setSending(false)
        return
      }
      setPendingPlan(null)
      setPlanMode(false)
      // 先接管流式状态,再重拉消息:重拉期间已经有步骤事件在路上了
      track(conversationId, res.data.runId)
      await loadMessages(conversationId)
      message.success(`计划已保存:${res.data.planPath}`)
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
      setSending(false)
    }
  }

  /** 按修改意见重出计划:意见先落成一条 user 行,再让 plan-agent 基于上一版修订 */
  const handleRevisePlan = async (feedback: string): Promise<void> => {
    const conversationId = activeIdRef.current
    if (conversationId === null || !currentRef) return
    const text = feedback.trim()
    if (!text) return
    setSending(true)
    try {
      const saved = await window.api.chat.sendMessage({ conversationId, content: text })
      if (!saved.success) {
        message.error(saved.msg)
        setSending(false)
        return
      }
      await loadMessages(conversationId)
      const started = await startRevision(conversationId, currentRef, text)
      if (!started.success) {
        message.error(started.msg)
        setSending(false)
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
      setSending(false)
    }
  }

  /** 放弃计划:聊天里的草稿行一起删掉;计划模式保留,用户可能想重来一次 */
  const handleDiscardPlan = async (): Promise<void> => {
    const conversationId = activeIdRef.current
    if (conversationId === null) return
    const res = await window.api.chat.discardPlan({ conversationId })
    if (!res.success) {
      message.error(res.msg)
      return
    }
    setPendingPlan(null)
    await loadMessages(conversationId)
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
    <div
      style={{
        display: 'flex',
        height: '100%',
        background: token.colorBgLayout
        // 顶栏预留不在这里:那样整条上沿都是侧栏底色,白画布上会多一条带。
        // 改由侧栏与画布各铺一条同底色的空白带,见 Sidebar / ChatPanel
      }}
    >
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={handleSelectConversation}
        onNew={newConversation}
        onNewInWorkspace={(dir) => void newConversationInWorkspace(dir)}
        onRename={handleRename}
        onDelete={handleDelete}
        onOpenSettings={openSettings}
        onOpenReport={openReport}
      />
      {/* 对话区整体兜底:它自己渲染炸了也不该把侧栏(换会话、新建对话)一起带走。
          切到别的会话时 activeId 变化会自动复位;点「重试」顺带重拉一次消息 */}
      <ErrorBoundary
        title="对话区渲染出错"
        resetKeys={[activeId]}
        onReset={() => {
          if (activeId) void loadMessages(activeId)
        }}
      >
        <ChatPanel
          messages={messages}
          streaming={shownRun}
          pendingQuestion={shownQuestion}
          pendingApproval={shownApproval}
          permissions={permissions}
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
          onPermissionChange={(next) => void handlePermissionChange(next)}
          onDecideApproval={(outcome, reason) => void handleDecideApproval(outcome, reason)}
          onOpenWhitelist={openPermissionSettings}
          onCompact={() => void handleCompact()}
          planMode={planMode}
          pendingPlan={pendingPlan}
          onCommand={handleCommand}
          onExitPlanMode={() => setPlanMode(false)}
          onApprovePlan={() => void handleApprovePlan()}
          onRevisePlan={(feedback) => void handleRevisePlan(feedback)}
          onDiscardPlan={() => void handleDiscardPlan()}
          onModelChange={handleModelChange}
          onOpenSettings={openSettings}
          onPickWorkspace={() => void handlePickWorkspace()}
          onSelectWorkspace={(dir) => void applyWorkspace(dir)}
          onClearWorkspace={() => void handleClearWorkspace()}
        />
      </ErrorBoundary>
    </div>
  )
}

export default ChatPage
