import { ThoughtChain } from '@ant-design/x'
import type { ThoughtChainProps } from '@ant-design/x'
import { Typography } from 'antd'
import type { StreamingToolCall } from '../hooks/useAgentStream'

interface ToolCallChainProps {
  calls: StreamingToolCall[]
}

/** 工具名到展示标题的映射;未列出的直接显示函数名 */
const TOOL_TITLES: Record<string, string> = {
  get_current_time: '获取当前时间'
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

const STATUS_MAP: Record<StreamingToolCall['status'], 'loading' | 'success' | 'error'> = {
  running: 'loading',
  success: 'success',
  error: 'error'
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

/** 以思维链形式展示一步内的工具调用:标题为工具名,展开可见参数与结果 */
function ToolCallChain({ calls }: ToolCallChainProps): React.JSX.Element {
  const items: ThoughtChainProps['items'] = calls.map((c) => ({
    key: c.id,
    title: displayTitle(c.name),
    description: c.status === 'running' ? '执行中…' : c.status === 'error' ? '执行失败' : '已完成',
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
      </div>
    )
  }))

  return <ThoughtChain items={items} style={{ marginBottom: 8 }} />
}

export default ToolCallChain
