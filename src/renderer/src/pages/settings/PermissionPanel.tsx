import { useState } from 'react'
import { Button, Divider, Flex, Segmented, Input, Typography, theme } from 'antd'
import type { PermissionMode, PermissionSettings } from '../../../../main/store/types'
import { LIST_ENTRY_SHAPES, MAX_LIST_ENTRIES, parsePermissionList } from '../../lib/permissionLists'
import { PERMISSION_OPTIONS, permissionModeOf } from '../../lib/permissionMode'

interface PermissionPanelProps {
  permissions: PermissionSettings
  /** 只改 App 那一份预览状态;落库由面板自己在提交时做(与外观同一套) */
  onChange: (next: PermissionSettings) => void
}

/** Segmented 给的是 string|number,回到 PermissionMode 靠穷举而不是断言 —— 认不出的一律最严那档 */
function toMode(value: string | number): PermissionMode {
  return value === 'auto' || value === 'full' ? value : 'ask'
}

interface ListEditorProps {
  label: string
  entries: string[]
  placeholder: string
  onSave: (next: string[]) => void
}

/**
 * 一份名单的编辑器:一行一条的纯文本。
 *
 * 不用 `Form.List`(一行一个输入框):名单是给人批量粘贴与整块编辑的,拆成多个输入框
 * 反而做不了「从终端复制十行贴进来」。
 * 「保存」只在文本与已落库的名单真有不一致时可点,否则用户会以为按钮坏了。
 */
function ListEditor({ label, entries, placeholder, onSave }: ListEditorProps): React.JSX.Element {
  const { token } = theme.useToken()
  const [text, setText] = useState(entries.join('\n'))
  const parsed = parsePermissionList(text)
  const dirty = parsed.join('\n') !== entries.join('\n')

  return (
    <Flex vertical gap={token.marginXS}>
      <Typography.Text strong>{label}</Typography.Text>
      <Input.TextArea
        value={text}
        placeholder={placeholder}
        autoSize={{ minRows: 3, maxRows: 10 }}
        onChange={(e) => setText(e.target.value)}
      />
      <Flex justify="space-between" align="center">
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {`${String(parsed.length)} 条${parsed.length >= MAX_LIST_ENTRIES ? '(已达上限,多余的行不会保存)' : ''}`}
        </Typography.Text>
        <Button size="small" type="primary" disabled={!dirty} onClick={() => onSave(parsed)}>
          保存
        </Button>
      </Flex>
    </Flex>
  )
}

/**
 * 权限:审批档位 + 黑白名单。
 *
 * 与外观同一条写入路径(整份 `permissions` 一个键整体落库),所以不会出现「改了档位、
 * 名单没落」的半状态;档位选择器与设置页写的是同一个键,真值只有一份(在 App)。
 */
function PermissionPanel({ permissions, onChange }: PermissionPanelProps): React.JSX.Element {
  const { token } = theme.useToken()
  const mode = permissionModeOf(permissions)
  const current = PERMISSION_OPTIONS.find((item) => item.value === mode) ?? PERMISSION_OPTIONS[0]

  const commit = (next: PermissionSettings): Promise<void> => {
    onChange(next)
    return window.api.settings.set('permissions', next)
  }

  return (
    <Flex vertical gap="middle" style={{ maxWidth: 760 }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        工具执行审批。这<strong>不是沙箱</strong>
        :审批挡的是「模型自己决定做的事」,一次误点允许,命令就真跑出去了。
        真正的工作空间限制与受限执行环境还在后面的期里。
      </Typography.Paragraph>

      <Flex vertical gap={token.marginXS}>
        <Typography.Text strong>档位</Typography.Text>
        <Segmented
          value={mode}
          options={PERMISSION_OPTIONS.map((item) => ({ label: item.label, value: item.value }))}
          onChange={(value) => {
            void commit({ ...permissions, mode: toMode(value) })
          }}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {current.hint}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          正在跑的那一轮按「收紧立即生效、放宽下一轮生效」处理;工作空间内的读写不审批,
          选了目录就意味着「这里随你写」。未选工作空间时 <code>write_file</code> 一律要审批。
        </Typography.Text>
      </Flex>

      <Divider style={{ margin: `${token.margin}px 0` }} />

      <Flex vertical gap={token.marginXXS}>
        <Typography.Text strong>名单条目的三种形状</Typography.Text>
        {LIST_ENTRY_SHAPES.map((shape) => (
          <Typography.Text key={shape} type="secondary" style={{ fontSize: 12 }}>
            · {shape}
          </Typography.Text>
        ))}
      </Flex>

      <ListEditor
        label="白名单(命中即免审批)"
        entries={permissions.allow ?? []}
        placeholder={'一行一条,例如:\ngit status\nnpm run build\ngithub__'}
        onSave={(next) => {
          void commit({ ...permissions, allow: next.length > 0 ? next : undefined })
        }}
      />

      <ListEditor
        label="黑名单(任何档位都要先问一次)"
        entries={permissions.deny ?? []}
        placeholder={'一行一条,例如:\nrm\ncurl\nwrite_file'}
        onSave={(next) => {
          void commit({ ...permissions, deny: next.length > 0 ? next : undefined })
        }}
      />

      <Divider style={{ margin: `${token.margin}px 0` }} />

      <Flex align="center" gap={token.marginXS}>
        <Typography.Text>
          {permissions.acknowledgeFullAccess === true
            ? '「完全访问」的风险已经确认过,切进那一档不再提示。'
            : '「完全访问」还没确认过,每次切进那一档都会先弹一次风险说明。'}
        </Typography.Text>
        {permissions.acknowledgeFullAccess === true && (
          <Button
            size="small"
            onClick={() => {
              // 写 undefined 即让 electron-store 丢掉这个键,与外观的「恢复默认」同一条路
              void commit({ ...permissions, acknowledgeFullAccess: undefined })
            }}
          >
            撤销确认
          </Button>
        )}
      </Flex>
    </Flex>
  )
}

export default PermissionPanel
