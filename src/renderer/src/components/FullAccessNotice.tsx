import { useState } from 'react'
import { Alert, Checkbox, Flex, Modal, Typography } from 'antd'

interface FullAccessNoticeProps {
  onCancel: () => void
  /** remember 为 true 时连同「以后不再询问」一起落库 */
  onConfirm: (remember: boolean) => void
}

/**
 * 风险清单。
 *
 * 写这四条是因为「完全访问」最容易被误解成「更安全地自动化」,而它实际是把闸门整个拆掉:
 * 用户得在点确认之前看见这一点,不是在出事之后。最后一条讲清唯一的残留闸门(黑名单),
 * 因为那是本期唯一在任何档位都拦得住的东西。
 */
const RISKS: string[] = [
  '没有沙箱:命令按模型给的原文执行,路径不受工作空间限制',
  '可以读写本机任意可访问的文件,包括用户目录与配置',
  '可以访问网络、起进程、删除内容,后果由本机承担',
  '唯一还生效的闸门是黑名单:命中名单的命令与工具仍然逐条审批'
]

/**
 * 进入「完全访问」前的风险确认。
 *
 * 由 PermissionPicker 在选中那一档时按需挂载(不是常驻 Modal 靠 open 切换):
 * 复选框的状态只属于这一次确认,挂载即新建、卸载即清空,不会出现「上次勾过这次还带着」。
 */
function FullAccessNotice({ onCancel, onConfirm }: FullAccessNoticeProps): React.JSX.Element {
  const [remember, setRemember] = useState(false)

  return (
    <Modal
      open
      title="切换到「完全访问」"
      okText="确认切换"
      cancelText="取消"
      onOk={() => onConfirm(remember)}
      onCancel={onCancel}
      // 红色:这一档没有回头路(命令已经跑出去了)。不逼用户先勾复选框 ——
      // 不勾就是「这一次确认」,下次进这一档还会再弹,那是更省事的一条路
      okButtonProps={{ danger: true }}
    >
      <Flex vertical gap="small">
        <Alert
          type="warning"
          showIcon
          message="这一档不再有任何审批"
          description="工具会在本机直接执行。日常用「询问审批」或「自动审批」就够了。"
        />
        {/* 逐条列出而不是写成一段话:一段话会被扫过去,四条各自是一类后果 */}
        {RISKS.map((risk) => (
          <Typography.Text key={risk} style={{ fontSize: 13 }}>
            · {risk}
          </Typography.Text>
        ))}
        <Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)}>
          我已知晓,以后不再询问
        </Checkbox>
      </Flex>
    </Modal>
  )
}

export default FullAccessNotice
