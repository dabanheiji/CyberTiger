import { useState } from 'react'
import { Flex, Typography, theme } from 'antd'
import type { DailyUsage } from '../../../main/stats/dto'
import { formatTokens } from '../../../main/tokens/estimate'
import { axisDayLabel, labelStep } from '../lib/reportRange'

interface UsageTrendChartProps {
  daily: DailyUsage[]
}

/**
 * 画布用的是 viewBox 而不是量出来的像素:内容列宽度会随窗口变,而 SVG 按比例缩放
 * 就不需要 ResizeObserver —— 观感上的代价是字跟着一起放大,在这张图的大小里看不出来。
 */
const WIDTH = 720
const HEIGHT = 200
const PAD_LEFT = 48
const PAD_RIGHT = 8
const PAD_TOP = 10
const PAD_BOTTOM = 22

/** 轴顶:留 5% 余量再向上取整到一位有效数字,免得最高的柱子直接顶到上边框 */
function axisTop(maxTotal: number): number {
  if (maxTotal <= 0) return 1
  const withHeadroom = maxTotal * 1.05
  const exponent = 10 ** Math.floor(Math.log10(withHeadroom))
  return Math.ceil(withHeadroom / exponent) * exponent
}

/**
 * 按天趋势:每天一根堆叠柱,输入在下、输出在上。
 *
 * 自绘 SVG,不引图表库。配色全部来自 `theme.useToken()`,所以暗色模式与用户自定义的
 * 强调色会自己传导进来 —— 这里不许出现任何写死的十六进制色。
 *
 * hover 的数字写在图上方那一行而不是画在柱顶上:柱子多的时候柱顶标签会互相压住,
 * 而行高是固定的,永远不会糊。没 hover 时那一行显示整段合计,免得空着像坏了。
 */
function UsageTrendChart({ daily }: UsageTrendChartProps): React.JSX.Element {
  const { token } = theme.useToken()
  const [hovered, setHovered] = useState<number | null>(null)

  const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM
  const slot = daily.length === 0 ? plotWidth : plotWidth / daily.length
  // 七天时每根柱之间留出一条能看见的缝;上千天时缝收成 0,不然柱宽会算成负数
  const gap = Math.min(6, slot * 0.25)
  const barWidth = Math.max(1, slot - gap)
  const maxTotal = daily.reduce((acc, item) => Math.max(acc, item.prompt + item.completion), 0)
  const top = axisTop(maxTotal)
  const yOf = (tokens: number): number => PAD_TOP + plotHeight - (tokens / top) * plotHeight
  const ticks = [0.25, 0.5, 0.75, 1].map((fraction) => Math.round(top * fraction))
  const step = labelStep(daily.length)
  const active = hovered === null ? null : daily[hovered]

  return (
    <Flex vertical gap={4}>
      <Flex align="baseline" justify="space-between" gap={token.marginXS}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {active
            ? `${active.day} · 输入 ${formatTokens(active.prompt)} · 输出 ${formatTokens(active.completion)} · ${active.steps} 次调用`
            : `整段合计 · 输入 ${formatTokens(daily.reduce((a, d) => a + d.prompt, 0))} · 输出 ${formatTokens(daily.reduce((a, d) => a + d.completion, 0))}`}
        </Typography.Text>
        <Flex align="center" gap={token.marginXS}>
          <Flex align="center" gap={4}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: token.colorFill,
                display: 'inline-block'
              }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              输入
            </Typography.Text>
          </Flex>
          <Flex align="center" gap={4}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: token.colorPrimary,
                display: 'inline-block'
              }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              输出
            </Typography.Text>
          </Flex>
        </Flex>
      </Flex>

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        role="img"
        aria-label="按天的 token 用量趋势"
        onMouseLeave={(): void => setHovered(null)}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD_LEFT}
              x2={WIDTH - PAD_RIGHT}
              y1={yOf(tick)}
              y2={yOf(tick)}
              stroke={token.colorBorderSecondary}
              strokeDasharray="2 4"
            />
            <text
              x={PAD_LEFT - 6}
              y={yOf(tick) + 3.5}
              textAnchor="end"
              fontSize={11}
              fill={token.colorTextTertiary}
            >
              {formatTokens(tick)}
            </text>
          </g>
        ))}
        <line
          x1={PAD_LEFT}
          x2={WIDTH - PAD_RIGHT}
          y1={yOf(0)}
          y2={yOf(0)}
          stroke={token.colorBorderSecondary}
        />

        {daily.map((item, index) => {
          const x = PAD_LEFT + index * slot + gap / 2
          const promptHeight = (item.prompt / top) * plotHeight
          const completionHeight = (item.completion / top) * plotHeight
          const isHovered = hovered === index
          return (
            <g key={item.day}>
              {/* 输入在下:它始终是这根柱的底座,输出叠在它上面 */}
              <rect
                x={x}
                y={yOf(0) - promptHeight}
                width={barWidth}
                height={promptHeight}
                fill={token.colorFill}
                opacity={isHovered ? 1 : 0.85}
              />
              <rect
                x={x}
                y={yOf(0) - promptHeight - completionHeight}
                width={barWidth}
                height={completionHeight}
                fill={token.colorPrimary}
                opacity={isHovered ? 1 : 0.85}
              />
              {/* 命中区是一整条竖列:零点几个像素的柱子按不到,而用户要的是「这天」 */}
              <rect
                x={PAD_LEFT + index * slot}
                y={PAD_TOP}
                width={slot}
                height={plotHeight}
                fill="transparent"
                onMouseEnter={(): void => setHovered(index)}
              />
            </g>
          )
        })}

        {daily.map((item, index) =>
          index % step === 0 ? (
            <text
              key={`label-${item.day}`}
              x={PAD_LEFT + index * slot + slot / 2}
              y={HEIGHT - 6}
              textAnchor="middle"
              fontSize={11}
              fill={token.colorTextTertiary}
            >
              {axisDayLabel(item.day)}
            </text>
          ) : null
        )}
      </svg>
    </Flex>
  )
}

export default UsageTrendChart
