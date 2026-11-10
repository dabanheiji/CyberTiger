import { BrowserWindow, dialog, Notification, type IpcMainInvokeEvent } from 'electron'
import {
  createFirstMessage,
  listConversations,
  listMessages,
  sendMessage as sendMessageService,
  renameConversation as renameConversationService,
  removeConversation as removeConversationService,
  generateReply as generateReplyService,
  abortReply as abortReplyService,
  compactConversationManually,
  answerQuestion as answerQuestionService,
  decideApproval as decideApprovalService,
  pendingApprovals as listPendingApprovals,
  pendingQuestions as listPendingQuestions,
  hasActiveWork,
  setConversationWorkspace,
  generatePlan as generatePlanService,
  revisePlan as revisePlanService,
  approvePlan as approvePlanService,
  discardPlan as discardPlanService,
  pendingPlan as pendingPlanService
} from './service'
import type {
  createFirstMessageDto,
  sendMessageDto,
  renameConversationDto,
  generateReplyDto,
  compactDto,
  setWorkspaceDto,
  answerQuestionDto,
  ApprovalRequest,
  decideApprovalDto,
  PendingApprovalDto,
  PendingQuestionDto,
  ChatStreamEvent,
  CompactReport,
  generatePlanDto,
  revisePlanDto,
  approvePlanDto,
  discardPlanDto,
  PendingPlanDto,
  ApprovePlanResult,
  IpcResult
} from './dto'
import type { Conversation, Message } from './sql'
import { ensureProjectRoot } from '../project'

/** 统一包装 handler 结果,异常转为 { success: false, msg } */
function run<T>(fn: () => T): IpcResult<T> {
  try {
    return { success: true, data: fn() }
  } catch (error) {
    return { success: false, msg: error instanceof Error ? error.message : String(error) }
  }
}

export function sendFirstMessage(
  _e: IpcMainInvokeEvent,
  dto: createFirstMessageDto
): IpcResult<{ conversationId: string }> {
  return run(() => ({ conversationId: createFirstMessage(dto) }))
}

export function getAllConversations(): IpcResult<{ conversations: Conversation[] }> {
  return run(() => ({ conversations: listConversations() }))
}

export function getMessages(
  _e: IpcMainInvokeEvent,
  conversationId: string
): IpcResult<{ messages: Message[] }> {
  return run(() => ({ messages: listMessages(conversationId) }))
}

export function sendMessage(
  _e: IpcMainInvokeEvent,
  dto: sendMessageDto
): IpcResult<{ messageId: string }> {
  return run(() => ({ messageId: sendMessageService(dto) }))
}

export function renameConversation(
  _e: IpcMainInvokeEvent,
  dto: renameConversationDto
): IpcResult<null> {
  return run(() => {
    renameConversationService(dto.conversationId, dto.title)
    return null
  })
}

export function removeConversation(
  _e: IpcMainInvokeEvent,
  conversationId: string
): IpcResult<null> {
  return run(() => {
    removeConversationService(conversationId)
    return null
  })
}

/** 把事件推给发起这次调用的渲染层;窗口已关闭时不再推送,但落库照常完成 */
function streamEmitter(e: IpcMainInvokeEvent): (event: ChatStreamEvent) => void {
  return (event: ChatStreamEvent): void => {
    if (!e.sender.isDestroyed()) e.sender.send('chat:stream', event)
  }
}

export function generateReply(
  e: IpcMainInvokeEvent,
  dto: generateReplyDto
): IpcResult<{ runId: string }> {
  const emit = streamEmitter(e)
  /**
   * 审批在等而窗口没在前台:来一条系统通知并把窗口叫回来。
   * 用户可能在别的应用里,而这一整轮正停在他身上 —— 没有这一步,审批看起来就像 Agent 卡死,
   * 而他会去做别的事。提问不需要这一条(它本来就期望用户此刻就在输入区)。
   */
  const notify = (request: ApprovalRequest): void => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isFocused() || win.isDestroyed()) return
    new Notification({ title: 'CyberTiger 在等你审批', body: request.summary }).show()
    win.focus()
  }
  return run(() => ({ runId: generateReplyService(dto, emit, notify) }))
}

export function abortReply(_e: IpcMainInvokeEvent, runId: string): IpcResult<null> {
  return run(() => {
    abortReplyService(runId)
    return null
  })
}

/**
 * 手动压缩一次会话的上下文。
 *
 * 这是个** awaited** 的 handler:压缩就是几次模型调用,渲染层要等它才能刷新占用环,
 * IPC 返回值天然就是「按钮的 loading 该在哪一刻停」。返回值不套 IpcResult 的既有约定不变,
 * 但 `compacted: false` 不是错误 —— 计划拒绝(省不出空间)也要正常回给界面解释原因。
 */
export async function compactContext(
  _e: IpcMainInvokeEvent,
  dto: compactDto
): Promise<IpcResult<CompactReport>> {
  try {
    return { success: true, data: await compactConversationManually(dto) }
  } catch (error) {
    return { success: false, msg: error instanceof Error ? error.message : String(error) }
  }
}

/** 弹系统对话框选工作空间目录;用户取消时 data 为 null,界面据此什么都不改 */
export async function pickWorkspace(e: IpcMainInvokeEvent): Promise<IpcResult<string | null>> {
  try {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options: Electron.OpenDialogOptions = {
      title: '选择工作空间',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return { success: true, data: null }
    // 选中即建出空的 `.cybertiger`:用户在这里只是挑目录,还没有会话行可写,
    // 所以脚手架落在这一层;失败只记日志,不影响选择本身
    ensureProjectRoot(result.filePaths[0])
    return { success: true, data: result.filePaths[0] }
  } catch (error) {
    return { success: false, msg: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 切换会话的工作空间。
 *
 * 拒掉正在 run 的会话:`startRun` 已把目录固定进那一轮,而工具正在按它解析相对路径 ——
 * 中途改写会让「上一秒的路径」和「下一秒的路径」指向不同目录,父子 run 还会分到两个基准。
 */
export function setWorkspace(_e: IpcMainInvokeEvent, dto: setWorkspaceDto): IpcResult<null> {
  return run(() => {
    if (hasActiveWork(dto.conversationId)) {
      throw new Error('这一轮还在进行中,请等它结束或先点击停止')
    }
    setConversationWorkspace(dto.conversationId, dto.dir)
    return null
  })
}

/**
 * 把用户的选择交回给正阻塞着的 ask_user 工具调用。
 *
 * answers 为空数组即「跳过」:主进程照样把这次等待了结,让模型带着「用户没给选择」继续,
 * 而不是让这一轮永远悬着。提问已了结(答案先到、本轮中止、会话被删)时 msg 说清去向,
 * 界面才知道这条答案没送出去。
 */
export function answerQuestion(_e: IpcMainInvokeEvent, dto: answerQuestionDto): IpcResult<null> {
  return run(() => {
    answerQuestionService(dto.questionId, dto.answers)
    return null
  })
}

/**
 * 把用户的决定交回给正阻塞着的工具调用。
 *
 * 与 answerQuestion 同一条纪律:id 对不上就报错,不静默丢 —— 静默失败看起来就是「按钮没反应」。
 * 拒绝与允许都照样了结这次等待,区别只在工具运没运行;超时与中止由主进程那侧自己收场,
 * 那时这条决定会拿到「已经失效了」的报错,界面据此收起卡片。
 */
export function decideApproval(_e: IpcMainInvokeEvent, dto: decideApprovalDto): IpcResult<null> {
  return run(() => {
    decideApprovalService(dto)
    return null
  })
}

/**
 * 当前还挂着的审批请求。
 * 渲染层重载(或它先于本次 run 的事件订阅就绪)时拉一次,把卡片填回来。
 */
export function pendingApprovals(): IpcResult<PendingApprovalDto[]> {
  return run(() => listPendingApprovals())
}

/**
 * 当前还挂着的提问。
 * 与 `pendingApprovals` 同一个洞:重载后流式状态归零,而主进程仍阻塞在那次 ask_user 上。
 */
export function pendingQuestions(): IpcResult<PendingQuestionDto[]> {
  return run(() => listPendingQuestions())
}

/**
 * 让 plan-agent 生成一份计划。
 *
 * 与 `generateReply` 同一形状:同步返回 runId,规划过程在后台跑并经 `chat:stream`
 * 推给渲染层(它流式显示读了哪些文件、问了什么)。需求本身已经是一条 user 行,
 * 所以这里没有 content 参数。
 */
export function generatePlan(
  e: IpcMainInvokeEvent,
  dto: generatePlanDto
): IpcResult<{ runId: string }> {
  return run(() => ({ runId: generatePlanService(dto, streamEmitter(e)) }))
}

/** 按用户的修改意见重出一版计划;修改意见已由界面落成 user 行 */
export function revisePlan(
  e: IpcMainInvokeEvent,
  dto: revisePlanDto
): IpcResult<{ runId: string }> {
  return run(() => ({ runId: revisePlanService(dto, streamEmitter(e)) }))
}

/**
 * 批准待审批的计划:落盘计划文件、写一条 `[计划执行]` user 行、启动主 run。
 *
 * 返回值里有本次执行 run 的 id,渲染层用它接管这一轮的流式状态 ——
 * 与 `generateReply` 返回 runId 是同一条理由。
 */
export function approvePlan(
  e: IpcMainInvokeEvent,
  dto: approvePlanDto
): IpcResult<ApprovePlanResult> {
  return run(() => approvePlanService(dto, streamEmitter(e)))
}

/** 放弃待审批的计划:删掉最后一条 user 行之后的 plan-agent 行 */
export function discardPlan(_e: IpcMainInvokeEvent, dto: discardPlanDto): IpcResult<null> {
  return run(() => {
    discardPlanService(dto)
    return null
  })
}

/**
 * 当前待审批的计划;没有就是 null。
 * 与 `pendingApprovals` 同一条路:重载后流式状态归零,卡片靠这一次拉取补回来。
 */
export function pendingPlan(
  _e: IpcMainInvokeEvent,
  conversationId: string
): IpcResult<PendingPlanDto | null> {
  return run(() => pendingPlanService(conversationId))
}
