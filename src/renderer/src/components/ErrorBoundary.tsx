import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button, Result, Space, Typography, theme } from 'antd'

interface ErrorBoundaryProps {
  children: ReactNode
  /** 出错的是界面的哪一块;兜底页要说清这一点,而不是一句笼统的「出错了」 */
  title?: string
  subTitle?: string
  /**
   * 这些值逐项浅比较后有任何变化,就自动清掉错误态。
   * 用在「换会话 / 换路由 / 换一轮 run 之后这块本来就该重来」的位置 ——
   * 用户不必先点一次重试才能接着用。
   */
  resetKeys?: readonly unknown[]
  /** 用户按下「重试」时回调:让上层重新拉一次数据,而不只是重画同一份坏数据 */
  onReset?: () => void
}

interface ErrorBoundaryState {
  error: Error | null
  /** React 给的组件栈:下次复现时,这里能直接指出是哪一个组件把提交链撑爆的 */
  componentStack: string
  /** 出错时那一版 resetKeys;下一次传入不同即自动复位 */
  keys: readonly unknown[] | null
}

const EMPTY_KEYS: readonly unknown[] = []

function sameKeys(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
}

interface FallbackProps {
  title: string
  subTitle: string
  error: Error
  componentStack: string
  onRetry: () => void
}

/**
 * 兜底内容本身只用最普通的 antd 组件:它是在「别处已经渲染炸了」之后才出现的,
 * 这里再引入任何有状态的东西,等于给同一个循环添一条新路径。
 */
function ErrorFallback({
  title,
  subTitle,
  error,
  componentStack,
  onRetry
}: FallbackProps): React.JSX.Element {
  const { token } = theme.useToken()
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: token.padding,
        overflow: 'auto',
        background: token.colorBgContainer
      }}
    >
      <div style={{ width: '100%', maxWidth: 720 }}>
        <Result
          status="warning"
          title={title}
          subTitle={subTitle}
          extra={
            <Space>
              <Button type="primary" onClick={onRetry}>
                重试
              </Button>
              <Button onClick={() => window.location.reload()}>重新加载</Button>
            </Space>
          }
        >
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: token.colorTextSecondary }}>
              错误详情（复现时把它复制给开发者）
            </summary>
            <Typography.Paragraph
              type="secondary"
              style={{ fontSize: 12, marginTop: token.marginXS, marginBottom: 0 }}
            >
              {error.name}: {error.message}
            </Typography.Paragraph>
            <pre
              style={{
                margin: `${token.marginXS}px 0 0`,
                padding: token.paddingXS,
                maxHeight: 220,
                overflow: 'auto',
                fontSize: 12,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                background: token.colorFillQuaternary,
                borderRadius: token.borderRadiusSM
              }}
            >
              {componentStack || '（没有组件栈）'}
            </pre>
          </details>
        </Result>
      </div>
    </div>
  )
}

/**
 * 渲染错误的兜底边界。
 *
 * React 19 对没有边界接住的渲染 / 提交期异常会整棵树卸载 —— 界面上就是一片白,
 * 连输入框和侧栏都没了。这一层的职责只有两件:把坏掉的那一块换成可读的说明,
 * 以及保留「重试 / 重新加载」这两条出路。
 *
 * 分层放置:越靠近出问题的地方越该有边界。消息列表炸了不该连输入框一起带走,
 * 对话区炸了不该连侧栏一起带走 —— 每一层都保留自己之外的部分可用。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: '', keys: null }

  // resetKeys 变了就自动复位。放在派生状态里而不是 effect 里:
  // 复位必须发生在渲染之前,否则会先拿旧错误状态提交一帧
  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState
  ): Partial<ErrorBoundaryState> | null {
    const keys = props.resetKeys ?? EMPTY_KEYS
    if (state.keys !== null && sameKeys(keys, state.keys)) return null
    return { keys, error: null, componentStack: '' }
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error, componentStack: '' }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台也留一份:开发者开着 DevTools 时不必先展开兜底页的详情
    console.error('[ErrorBoundary]', this.props.title ?? '未命名区域', error, info.componentStack)
    this.setState({ componentStack: info.componentStack ?? '' })
  }

  reset = (): void => {
    this.setState({ error: null, componentStack: '' })
    this.props.onReset?.()
  }

  render(): ReactNode {
    const { error, componentStack } = this.state
    if (!error) return this.props.children
    return (
      <ErrorFallback
        title={this.props.title ?? '这块内容渲染出错了'}
        subTitle={this.props.subTitle ?? '这块内容在渲染时出错了，界面的其它部分仍然可用。'}
        error={error}
        componentStack={componentStack}
        onRetry={this.reset}
      />
    )
  }
}

export default ErrorBoundary
