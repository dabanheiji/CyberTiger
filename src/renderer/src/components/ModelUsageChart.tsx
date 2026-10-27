import { Flex, Typography, theme } from 'antd'
import type { ModelUsage } from '../../../main/stats/dto'
import { formatTokens } from '../../../main/tokens/estimate'
import { modelDisplayName, percentText, providerSuffix } from '../lib/reportRange'

interface ModelUsageChartProps {
  byModel: ModelUsage[]
}

const WIDTH = 720
const ROW_HEIGHT = 30
const BAR_HEIGHT = 12
const LABEL_WIDTH = 220
const VALUE_WIDTH = 130
/** 名称列放不下时的截断长度:SVG 的 text 不会自己加省略号,不截就会压到柱子上 */
const LABEL_MAX = 24

function truncate(text: string): string {
  return text.length <= LABEL_MAX ? text : `${text.slice(0, LABEL_MAX - 1)}…`
}

/**
 * 按模型的用量排行:一根横条一行,右边写绝对量和占比。
 *
 * 排序、分组、占比都由主进程算好(`stats/aggregate.ts`),这一层只画。
 * 「未记录模型」那一桶是加模型归属那两列之前的历史数据 —— 它排在最前面是事实而不是 bug,
 * 界面上面那段说明负责解释它为什么存在。
 */
function ModelUsageChart({ byModel }: ModelUsageChartProps): React.JSX.Element {
  const { token } = theme.useToken()
  const plotWidth = WIDTH - LABEL_WIDTH - VALUE_WIDTH
  const maxTotal = byModel.reduce((acc, item) => Math.max(acc, item.total), 0)
  const height = Math.max(1, byModel.length) * ROW_HEIGHT
  // 最高的那根铺满可用宽度:横条比的是相对长短,除以最大值比除以总量更好读
  const widthOf = (total: number): number =>
    maxTotal === 0 ? 0 : Math.max(1, (total / maxTotal) * plotWidth)

  return (
    <Flex vertical gap={4}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        共 {byModel.length} 个「服务商 + 模型」组合,占比按 token 总量算
      </Typography.Text>
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        width="100%"
        role="img"
        aria-label="按模型的 token 用量排行"
      >
        {byModel.map((item, index) => {
          const label = modelDisplayName(item.model)
          const centerY = index * ROW_HEIGHT + ROW_HEIGHT / 2
          return (
            <g key={`${item.providerId}\u0000${item.model}`}>
              {/* 名称是用户配出来的,长度没准;SVG 的 text 不会自己截断,所以除省略号外
                  再给一份 title,截掉了也看得到全文 */}
              <text x={0} y={centerY + 4} fontSize={12} fill={token.colorText}>
                <title>{`${label}${providerSuffix(item.providerName)}`}</title>
                {truncate(label)}
              </text>
              <rect
                x={LABEL_WIDTH}
                y={centerY - BAR_HEIGHT / 2}
                width={plotWidth}
                height={BAR_HEIGHT}
                rx={2}
                fill={token.colorFillQuaternary}
              />
              <rect
                x={LABEL_WIDTH}
                y={centerY - BAR_HEIGHT / 2}
                width={widthOf(item.total)}
                height={BAR_HEIGHT}
                rx={2}
                fill={token.colorPrimary}
              />
              <text
                x={WIDTH}
                y={centerY + 4}
                textAnchor="end"
                fontSize={12}
                fill={token.colorTextSecondary}
              >
                {`${formatTokens(item.total)} · ${percentText(item.share)}`}
                <title>{`${item.steps} 次调用,其中估算 ${formatTokens(item.estimatedTokens)}`}</title>
              </text>
            </g>
          )
        })}
      </svg>
    </Flex>
  )
}

export default ModelUsageChart
