import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Flex,
  Radio,
  Row,
  Spin,
  Statistic,
  Typography,
  theme
} from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import type { UsageStatsReport } from '../../../../main/stats/dto'
import { formatTokens } from '../../../../main/tokens/estimate'
import UsageTrendChart from '../../components/UsageTrendChart'
import ModelUsageChart from '../../components/ModelUsageChart'
import {
  QUICK_RANGES,
  matchingQuickRange,
  percentText,
  quickRange,
  type DayRange,
  type QuickRange
} from '../../lib/reportRange'

/**
 * 口径说明。写成常量而不是 JSX 里的长句:JSX 折行会在中文句子中间物化成空格,
 * 而这一段正好是最容易被读的一句(界面上唯一解释「未记录模型」和「估算占比」的地方)。
 */
const SCOPE_NOTE =
  '这里统计的是对话里的模型调用,子 Agent 的每一步也算在内。上下文压缩那几次调用的用量单独记在会话上,不进这份账。' +
  '模型归属是从这次更新起才逐行记录的:之前写下的那些行没有模型名,它们归进「未记录模型」这一桶,照样算进总量,只是认不出是谁跑的。' +
  '「估算占比」是端点没有上报用量、由本地估算计入的那部分 token —— 这个数偏高的时候,上面的绝对量只能当量级看,不能当账单看。'

/** 六张指标卡:总量与输入输出是消耗,调用次数与活跃天数是节奏,估算占比是这批数的可信度 */
function metricCards(report: UsageStatsReport): { title: string; value: string; hint: string }[] {
  const { totals, daily } = report
  return [
    {
      title: '总 token',
      value: formatTokens(totals.total),
      hint: `${totals.steps} 次模型调用`
    },
    { title: '输入', value: formatTokens(totals.prompt), hint: '每次请求带过去的内容' },
    { title: '输出', value: formatTokens(totals.completion), hint: '模型写回来的部分' },
    {
      title: '估算占比',
      value: percentText(totals.estimatedRatio),
      hint: `约 ${formatTokens(totals.estimatedTokens)} 是本地估算`
    },
    {
      title: '活跃天数',
      value: `${totals.activeDays} / ${daily.length}`,
      hint: '这段区间里有用的那天'
    },
    {
      title: '平均每天',
      value: formatTokens(
        totals.activeDays === 0 ? 0 : Math.round(totals.total / totals.activeDays)
      ),
      hint: '只按活跃天数摊'
    }
  ]
}

function ReportPage(): React.JSX.Element {
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const { message } = App.useApp()
  const [range, setRange] = useState<DayRange>(() => quickRange('last7'))
  /**
   * 结果连同「它是哪个区间的结果」一起存,于是 loading 是一个派生值而不是一个状态位。
   * 分开写两份会有两种坏味道:effect 里同步 setState(React 不建议,eslint 也拦),
   * 以及换区间时旧数据被清掉、页面空转一次「什么都没有」而不是让旧数据垫在 Spin 底下。
   */
  const [loaded, setLoaded] = useState<{
    range: DayRange
    report: UsageStatsReport | null
  } | null>(null)
  const loading = !loaded || loaded.range.from !== range.from || loaded.range.to !== range.to
  // 出错那一次 report 是 null:空图读起来像「这段时间没用过」,而实际是统计没跑成
  const report = loaded?.report ?? null

  useEffect(() => {
    let cancelled = false
    void (async (): Promise<void> => {
      const result = await window.api.stats.report(range)
      // 只在 promise 的延续里 setState:effect 体内同步 setState 会引发级联渲染
      if (cancelled) return
      if (result.success) setLoaded({ range, report: result.data })
      else {
        setLoaded({ range, report: null })
        message.error(result.msg)
      }
    })()
    return (): void => {
      cancelled = true
    }
  }, [range, message])

  const preset = matchingQuickRange(range)

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: token.colorBgLayout
      }}
    >
      {/* 无边框顶栏:与设置页同底色那条带,否则「返回对话」会压在红绿灯上 */}
      <div className="cybertiger-titlebar-drag" />
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <div style={{ maxWidth: 880, margin: '0 auto', padding: token.paddingLG }}>
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate('/')}
            style={{ marginBottom: token.marginXS }}
          >
            返回对话
          </Button>

          <Flex vertical gap={token.marginXS}>
            <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 0 }}>
              用量报表
            </Typography.Title>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {`${range.from} 至 ${range.to}`}
            </Typography.Paragraph>
          </Flex>

          <Flex align="center" gap={token.marginSM} wrap style={{ marginTop: token.marginSM }}>
            <Radio.Group
              value={preset ?? ''}
              onChange={(e) => setRange(quickRange(e.target.value as QuickRange))}
              options={QUICK_RANGES.map((item) => ({ label: item.label, value: item.value }))}
              optionType="button"
              buttonStyle="solid"
              size="small"
            />
            {/* 不给受控 value:那需要直接依赖 dayjs,而它是 antd 的传递依赖、本项目没声明。
                选了快捷区间时整块靠 key 重挂成空的,所以「选择器里有日期」只会是用户自己框的 */}
            <DatePicker.RangePicker
              key={preset ?? 'custom'}
              size="small"
              allowClear={false}
              onChange={(dates) => {
                const [from, to] = dates ?? []
                if (!from || !to) return
                setRange({ from: from.format('YYYY-MM-DD'), to: to.format('YYYY-MM-DD') })
              }}
            />
          </Flex>

          <Typography.Paragraph
            type="secondary"
            style={{ marginTop: token.marginSM, marginBottom: 0, fontSize: 12 }}
          >
            {SCOPE_NOTE}
          </Typography.Paragraph>

          <Spin spinning={loading}>
            {report && report.totals.steps === 0 ? (
              <Card style={{ marginTop: token.marginLG }}>
                <Empty description="这段时间没有模型调用" />
              </Card>
            ) : (
              report && (
                <>
                  <Row
                    gutter={[token.marginSM, token.marginSM]}
                    style={{ marginTop: token.marginLG }}
                  >
                    {metricCards(report).map((card) => (
                      <Col key={card.title} xs={12} sm={8}>
                        <Card size="small">
                          <Statistic title={card.title} value={card.value} />
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {card.hint}
                          </Typography.Text>
                        </Card>
                      </Col>
                    ))}
                  </Row>

                  <Card
                    title="按天趋势"
                    style={{ marginTop: token.marginLG }}
                    extra={
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        悬停某一天看它那天的数
                      </Typography.Text>
                    }
                  >
                    <UsageTrendChart daily={report.daily} />
                  </Card>

                  <Card title="按模型" style={{ marginTop: token.marginLG }}>
                    <ModelUsageChart byModel={report.byModel} />
                  </Card>
                </>
              )
            )}
          </Spin>
        </div>
      </div>
    </div>
  )
}

export default ReportPage
