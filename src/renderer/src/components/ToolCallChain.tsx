import { useState } from 'react'
import { ThoughtChain } from '@ant-design/x'
import type { ThoughtChainProps } from '@ant-design/x'
import { Typography } from 'antd'
import type { StreamingToolCall } from '../lib/agentSteps'

interface ToolCallChainProps {
  calls: StreamingToolCall[]
  /** 渲染在参数/结果之后的自定义内容(目前用于子 Agent 的执行过程) */
  renderDetail?: (call: StreamingToolCall) => React.ReactNode
}

/** 工具名到展示标题的映射;未列出的直接显示函数名 */
const TOOL_TITLES: Record<string, string> = {
  get_current_time: '获取当前时间',
  task: '派生子 Agent'
}

/** MCP 工具名形如 server__tool,拆出 server 作为来源标注 */
function displayTitle(name: string): React.ReactNode {
  if (TOOL_TITLES[name]) return TOOL_TITLES[name]
  const sep = name.indexOf('__')
  if (sep <= 0) return name
  return (
    <>
      {name.slice(sep + 2)}
      <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
        {name.slice(0, sep)}
      </Typography.Text>
    </>
  )
}

/** 派生调用优先显示模型给的任务简述,比函数名更有信息量 */
function callTitle(call: StreamingToolCall): React.ReactNode {
  if (call.name !== 'task') return displayTitle(call.name)
  let description = ''
  try {
    const parsed: unknown = JSON.parse(call.arguments)
    if (parsed && typeof parsed === 'object' && 'description' in parsed) {
      const value = (parsed as { description?: unknown }).description
      if (typeof value === 'string') description = value
    }
  } catch {
    // 参数可能尚未流完或不合法,退回函数名
  }
  return (
    <>
      {TOOL_TITLES.task}
      {!!description && (
        <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
          {description}
        </Typography.Text>
      )}
    </>
  )
}

const STATUS_MAP: Record<StreamingToolCall['status'], 'loading' | 'success' | 'error'> = {
  running: 'loading',
  success: 'success',
  error: 'error'
}

/** 状态文案;命中去重缓存时写明,免得看起来像又执行了一遍 */
function callDescription(call: StreamingToolCall): string {
  if (call.status === 'running') return '执行中…'
  if (call.reused) return '已复用本轮结果'
  return call.status === 'error' ? '执行失败' : '已完成'
}

/** 参数 JSON 尽量美化;模型给的可能不合法,失败时原样显示 */
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

const preStyle: React.CSSProperties = {
  margin: 0,
  maxHeight: 200,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  fontSize: 12
}

/**
 * 默认展开的调用:正在执行的,以及带子 Agent 过程的。
 * 用数据而不是"是否曾经运行过"来决定,这样运行结束后气泡改用落库数据重渲染
 * (组件会重新挂载)时,子 Agent 的过程依然直接可见,不必再点一次。
 */
function defaultExpandedKeys(calls: StreamingToolCall[]): string[] {
  return calls
    .filter((c) => c.status === 'running' || (c.agentSteps?.length ?? 0) > 0)
    .map((c) => c.id)
}

/**
 * 以思维链形式展示一步内的工具调用:标题为工具名,展开可见参数、结果与子 Agent 过程。
 * 运行中的调用与带子 Agent 过程的调用默认展开,普通调用默认收起;之后不自动收起,交给用户切换。
 */
function ToolCallChain({ calls, renderDetail }: ToolCallChainProps): React.JSX.Element {
  const autoKeys = defaultExpandedKeys(calls)
  const signature = autoKeys.join(',')
  const [expandedKeys, setExpandedKeys] = useState<string[]>(autoKeys)
  const [prevSignature, setPrevSignature] = useState(signature)

  if (signature !== prevSignature) {
    setPrevSignature(signature)
    // 只并入新出现的应展开项,不覆盖用户已有的展开/收起选择
    setExpandedKeys((keys) => [...new Set([...keys, ...autoKeys])])
  }

  const items: ThoughtChainProps['items'] = calls.map((c) => ({
    key: c.id,
    title: callTitle(c),
    description: callDescription(c),
    status: STATUS_MAP[c.status],
    collapsible: true,
    content: (
      <div>
        <Typography.Text type="secondary">参数</Typography.Text>
        <pre style={preStyle}>{prettyJson(c.arguments) || '{}'}</pre>
        {c.result !== undefined && (
          <>
            <Typography.Text type="secondary">结果</Typography.Text>
            <pre style={preStyle}>{prettyJson(c.result)}</pre>
          </>
        )}
        {renderDetail?.(c)}
      </div>
    )
  }))

  return (
    <ThoughtChain
      items={items}
      expandedKeys={expandedKeys}
      onExpand={setExpandedKeys}
      style={{ marginBottom: 8 }}
    />
  )
}

export default ToolCallChain
