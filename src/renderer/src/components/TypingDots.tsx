import { theme } from 'antd'

/**
 * 正文末尾的「还在生成」指示:三颗上下跳动的小圆点。
 *
 * @ant-design/x 的 Bubble 只在**还没有任何正文**时用 loading 占位(那会把 content 整段换掉),
 * 一旦第一个 token 到达就只剩逐字增长的正文。首 token 之后的慢速生成在界面上看起来像卡住了,
 * 所以在正文尾部补一颗一直动着的指示,run 结束(streaming 变 false)时它随正文一起消失。
 *
 * 节奏照组件库那一份加载态抄:4px 圆点、2s 线性、上下 4px、三颗依次错开 0.2s(见 main.css)。
 * 颜色走 `colorPrimary`,与加载态同一颗强调色;动画全在 CSS 里跑,不为它加任何计时器 ——
 * 流式内容本来每帧都在重建,再把指示器挂到一个 React state 上只会多一份无谓的重渲。
 */
function TypingDots(): React.JSX.Element {
  const { token } = theme.useToken()
  return (
    <span
      className="cybertiger-typing-dots"
      style={{ color: token.colorPrimary }}
      role="status"
      aria-label="正在生成回复"
    >
      <i />
      <i />
      <i />
    </span>
  )
}

export default TypingDots
