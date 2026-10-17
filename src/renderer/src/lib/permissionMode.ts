import type { PermissionMode, PermissionSettings } from '../../../main/store/types'

/**
 * 权限档位的界面文案。
 *
 * 底栏那颗选择器与设置页的「权限」面板共用一份:两处各写一套就会出现「界面上叫自动审批、
 * 说明里叫智能放行」,而这三档的差别恰恰只能靠文案讲清。
 */

export interface PermissionOption {
  value: PermissionMode
  /** 选择器收起时显示的那两个字 */
  label: string
  /** 下拉里跟在标题后面的那句说明:三档的区别全靠它,不写用户猜不到边界 */
  hint: string
}

export const PERMISSION_OPTIONS: PermissionOption[] = [
  { value: 'ask', label: '询问审批', hint: '每条命令、每次越出工作空间的读写都先问一次' },
  { value: 'auto', label: '自动审批', hint: '证明得了只读的命令直接执行,其余照样要问' },
  { value: 'full', label: '完全访问', hint: '不再审批;命中黑名单的条目除外' }
]

/**
 * 没设置过就是最严的那一档。
 * 默认值只在这里出现一次,主进程那边的判定同样按 'ask' 走(`store` 里没进 defaults)。
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'ask'

export function permissionModeOf(permissions?: PermissionSettings): PermissionMode {
  const mode = permissions?.mode
  return mode === 'auto' || mode === 'full' ? mode : DEFAULT_PERMISSION_MODE
}
