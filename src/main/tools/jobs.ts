import { MAX_JOBS_PER_CONVERSATION, MAX_JOBS_TOTAL } from '../process/jobs'
import type { JobEndBy, JobManager, JobRecord } from '../process/jobs'
import { anchor } from './paths'
import type { ToolDefinition } from './types'

const ACTIONS = ['start', 'list', 'logs', 'stop'] as const

/** 日志一次读末尾这么多字符:与前台命令的输出上限同一量级 */
const LOG_TAIL_CHARS = 4_000

function durationText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

function endByText(by: JobEndBy | null): string {
  switch (by) {
    case 'stopped':
      return '由你停止'
    case 'external':
      return '由外部终止'
    case 'app-quit':
      return '应用退出时被终止'
    case 'conversation-deleted':
      return '会话删除时被终止'
    default:
      return ''
  }
}

function statusText(record: JobRecord): string {
  if (record.status === 'running') {
    return `运行中 (pid ${record.pid},已运行 ${durationText(Date.now() - record.startedAt)})`
  }
  if (record.status === 'lost') return '状态未知 (进程已经不在,原因见日志)'
  const code =
    record.exitCode === null ? `信号 ${record.signal || '未知'}` : `exit_code=${record.exitCode}`
  const why = endByText(record.by)
  return `已结束 (${code}${why ? `,${why}` : ''})`
}

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function logBlock(text: string): string {
  if (!text.trim()) return '(还没有输出)'
  return text.replace(/\n$/, '')
}

function actionOf(value: unknown): (typeof ACTIONS)[number] {
  const action = typeof value === 'string' ? value.trim() : ''
  if (!action) return 'start'
  if ((ACTIONS as readonly string[]).includes(action)) return action as (typeof ACTIONS)[number]
  throw new Error(`action 要是 ${ACTIONS.join(' / ')} 之一,收到的是 ${action}`)
}

function jobIdOf(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) throw new Error('缺少 job_id')
  return id
}

/**
 * 后台作业工具。
 *
 * 与 `ask_user` / `task` 一样按 run 现构造:作业归属于**会话**,而 `ToolContext` 不带会话 id
 * (它带的是 callId / workspace / jail / signal)。也正因为不进 `builtinTools`,
 * 子 Agent 的工具池天然没有它 —— 子 Agent 留下的常驻进程没有人在界面上看得见。
 *
 * 这里的 `jail` 仍然从 `ToolContext` 来:启动器是主 run 那一份快照的产物,
 * 子进程与前台命令用同一个根、同一道边界。
 */
export function createBackgroundJobTool(
  manager: JobManager,
  conversationId: string
): ToolDefinition {
  return {
    name: 'background_job',
    description:
      '在后台启动一条命令,或者查看 / 停止已经启动的后台作业。' +
      'action=start 用 command 与 cwd 启动:进程不在本次调用结束时被终止,适合开发服务器、' +
      '文件监听、长时间运行的任务这类要一直留在机器上的东西。' +
      '它的输出写在日志文件里,action=logs 读末尾,action=stop 结束它,action=list 列出本会话的全部作业。' +
      `每个会话同时最多 ${MAX_JOBS_PER_CONVERSATION} 个、全局最多 ${MAX_JOBS_TOTAL} 个后台作业;` +
      '退出应用或删除会话时它们会被一并终止。' +
      '工作目录与 run_command 同一条规则:绝对路径、~ 开头,或相对本次会话工作空间。' +
      '沙箱设置同样生效:文件写入出不了本次会话的工作空间与临时目录,清单点名的凭据目录读不到,' +
      '网络是否放行也跟那一条设置一致。' +
      'start 与其他会动本机的操作一样要过用户审批;list / logs / stop 不碰机器,不需要审批。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...ACTIONS],
          description:
            'start 启动;list 列出本会话的作业;logs 读某个作业的输出末尾;stop 停止某个作业'
        },
        command: { type: 'string', description: 'action=start 时要执行的完整命令行' },
        cwd: {
          type: 'string',
          description: 'action=start 时的工作目录:绝对路径、~ 开头,或相对本次会话工作空间'
        },
        job_id: { type: 'string', description: 'action=logs / stop 时的作业编号' }
      },
      required: ['action']
    },
    execute: async (args, context): Promise<string> => {
      const action = actionOf(args.action)

      if (action === 'list') {
        const jobs = manager.list(conversationId)
        if (jobs.length === 0) return '本会话没有后台作业。'
        const lines = jobs.map(
          (record) =>
            `- ${record.id} | ${statusText(record)} | 工作目录 ${record.cwd} | 命令 ${oneLine(record.command)}`
        )
        return [`本会话的后台作业共 ${jobs.length} 个:`, ...lines].join('\n')
      }

      if (action === 'logs') {
        const id = jobIdOf(args.job_id)
        const { record, text } = manager.logs(conversationId, id, LOG_TAIL_CHARS)
        return [
          `${record.id} | ${statusText(record)}`,
          `命令: ${oneLine(record.command, 400)}`,
          `工作目录: ${record.cwd}`,
          '--- 输出末尾 ---',
          logBlock(text)
        ].join('\n')
      }

      if (action === 'stop') {
        const id = jobIdOf(args.job_id)
        const before = manager.list(conversationId).find((record) => record.id === id)
        if (before && before.status !== 'running') {
          return `${id} 早已结束,状态没有变化:${statusText(before)}`
        }
        const record = await manager.stop(conversationId, id)
        return [
          `${record.id} | ${statusText(record)}`,
          '这次调用发出的停止对整个进程组生效。'
        ].join('\n')
      }

      const command = String(args.command ?? '').trim()
      if (!command) throw new Error('缺少 command')
      const workspace = context.workspace ?? ''
      const target = anchor(typeof args.cwd === 'string' ? args.cwd : '', workspace)

      const exec = context.jail?.exec
      // 与 run_command 同一条纪律:引擎装不上就拒这一条,绝不退回不受限地常驻
      if (exec?.state === 'unavailable') {
        throw new Error(`受限执行在这台机器上装不上,后台作业没有启动:${exec.reason}`)
      }
      const launch = exec?.state === 'confined' ? exec.launch : undefined
      const persistLaunch =
        exec?.state === 'confined' ? (exec.persistLaunch ?? exec.launch) : undefined

      const record = await manager.start({
        conversationId,
        command,
        cwd: target.path,
        launch,
        persistLaunch
      })
      const head = [
        `${record.id} | ${statusText(record)}`,
        `命令: ${oneLine(command, 400)}`,
        `工作目录: ${record.cwd}`,
        `日志文件: ${record.logPath}`
      ]
      if (record.status === 'running') {
        head.push(
          '这个作业在本轮结束后继续运行;后续可以用 action=logs 读它的输出,用 action=stop 结束它。'
        )
        return head.join('\n')
      }
      const { text } = manager.logs(conversationId, record.id, LOG_TAIL_CHARS)
      return [...head, '--- 输出末尾 ---', logBlock(text)].join('\n')
    }
  }
}
