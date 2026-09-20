import { useLayoutEffect, useRef, useState } from 'react'
import { Think } from '@ant-design/x'

interface ReasoningBoxProps {
  reasoning: string
  /** 模型正在输出思考(流式中且正文尚未开始):自动展开并跟随滚动 */
  thinking: boolean
  maxHeight?: number
}

/** 距底部多少像素以内视为"贴底",此时新内容到来才跟随滚动 */
const STICK_THRESHOLD = 24

/**
 * 展示模型思考过程。
 * 默认折叠;开始思考时自动展开,正文开始输出时自动折叠;期间用户可手动切换。
 * 展开且思考中时自动跟随到底部,用户手动上滚后停止跟随,再滚回底部则恢复。
 */
function ReasoningBox({
  reasoning,
  thinking,
  maxHeight = 160
}: ReasoningBoxProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const [expanded, setExpanded] = useState(thinking)
  const [prevThinking, setPrevThinking] = useState(thinking)

  // 只在 thinking 状态切换的瞬间改变展开态,不覆盖用户在中途的手动操作
  // (React 推荐的"渲染期间响应 prop 变化"写法,替代在 effect 里 setState)
  if (thinking !== prevThinking) {
    setPrevThinking(thinking)
    setExpanded(thinking)
  }

  const handleScroll = (): void => {
    const el = ref.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD
  }

  // 用 layoutEffect 在绘制前滚动,避免先看到旧位置再跳一下
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !thinking || !expanded || !stickToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [reasoning, thinking, expanded])

  return (
    <Think
      title={thinking ? '思考中' : '深度思考'}
      loading={thinking}
      expanded={expanded}
      onExpand={setExpanded}
    >
      <div
        ref={ref}
        onScroll={handleScroll}
        style={{ maxHeight, overflow: 'auto', whiteSpace: 'pre-wrap' }}
      >
        {reasoning}
      </div>
    </Think>
  )
}

export default ReasoningBox
