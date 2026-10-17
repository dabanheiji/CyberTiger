import { useState } from 'react'
import { Flex, Select, Typography, theme } from 'antd'
import type { PermissionMode, PermissionSettings } from '../../../../main/store/types'
import { PERMISSION_OPTIONS, permissionModeOf } from '../../lib/permissionMode'
import FullAccessNotice from '../../components/FullAccessNotice'

interface PermissionPickerProps {
  permissions: PermissionSettings
  /** 整份 permissions 交给父层写 store:档位与名单同一个键,不会只落一半 */
  onChange: (next: PermissionSettings) => void
}

/**
 * 底栏的权限档位选择器。
 *
 * 与 WorkspacePicker 相反,这一颗**不因 sending 而禁用**:它是急刹车,
 * 跑着的时候更要能按。语义由主进程兜(收紧立即生效、放宽下一轮生效)。
 */
function PermissionPicker({ permissions, onChange }: PermissionPickerProps): React.JSX.Element {
  const { token } = theme.useToken()
  const [noticing, setNoticing] = useState(false)
  const mode = permissionModeOf(permissions)

  const commit = (next: PermissionMode): void => {
    onChange({ ...permissions, mode: next })
  }

  const pick = (next: PermissionMode): void => {
    if (next === mode) return
    // 进「完全访问」要先过一次风险确认,除非用户明确勾过「以后不再询问」
    if (next === 'full' && permissions.acknowledgeFullAccess !== true) {
      setNoticing(true)
      return
    }
    commit(next)
  }

  return (
    <>
      <Select<PermissionMode>
        size="small"
        variant="borderless"
        value={mode}
        // 三档的差别只在文案里,收起状态看不到;所以下拉每一项都带一句说明
        options={PERMISSION_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
        optionRender={(option) => {
          const item = PERMISSION_OPTIONS.find((o) => o.value === option.value)
          return (
            <Flex vertical gap={0}>
              <span>{item?.label ?? String(option.value)}</span>
              {item && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {item.hint}
                </Typography.Text>
              )}
            </Flex>
          )
        }}
        // 完全访问要用警告色标出来:它常驻底栏,而「现在没有任何审批」这件事得一直在眼前
        labelRender={(item) => {
          const current = PERMISSION_OPTIONS.find((o) => o.value === item.value) ?? null
          return (
            <span style={current?.value === 'full' ? { color: token.colorWarning } : undefined}>
              {current?.label ?? String(item.value)}
            </span>
          )
        }}
        onChange={(value) => pick(value)}
        popupMatchSelectWidth={false}
        style={{ minWidth: 88 }}
      />
      {noticing && (
        <FullAccessNotice
          onCancel={() => setNoticing(false)}
          onConfirm={(remember) => {
            setNoticing(false)
            // 没勾「以后不再询问」就只写档位:下次进这一档还要确认
            onChange({
              ...permissions,
              mode: 'full',
              ...(remember ? { acknowledgeFullAccess: true } : {})
            })
          }}
        />
      )}
    </>
  )
}

export default PermissionPicker
