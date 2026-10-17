import type { PermissionSettings } from '../../../src/main/store/types'
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_OPTIONS,
  permissionModeOf
} from '../../../src/renderer/src/lib/permissionMode'

describe('permissionModeOf', () => {
  it('没设置过就是最严那一档:默认值只在这里出现一次,与主进程判定同一条', () => {
    expect(permissionModeOf(undefined)).toBe('ask')
    expect(permissionModeOf({})).toBe('ask')
    expect(DEFAULT_PERMISSION_MODE).toBe('ask')
  })

  it('认得出三种合法值:底栏那颗与设置页的 Segmented 都靠它显示当前档位', () => {
    expect(permissionModeOf({ mode: 'ask' })).toBe('ask')
    expect(permissionModeOf({ mode: 'auto' })).toBe('auto')
    expect(permissionModeOf({ mode: 'full' })).toBe('full')
  })

  it('脏值回落到最严那一档:配置文件里出现别的写法时,不能把它读成「免审批」', () => {
    const bad = { mode: 'everything' } as unknown as PermissionSettings
    expect(permissionModeOf(bad)).toBe('ask')
  })
})

describe('PERMISSION_OPTIONS', () => {
  it('三档齐且顺序是 ask → auto → full:底栏下拉与设置页 Segmented 共用这份,顺序不一致会读乱', () => {
    expect(PERMISSION_OPTIONS.map((item) => item.value)).toEqual(['ask', 'auto', 'full'])
  })

  it('每档都有标题和一句说明:三档的边界只能靠文案讲清,少一条就说明白了个大概', () => {
    for (const item of PERMISSION_OPTIONS) {
      expect(item.label).toBeTruthy()
      expect(item.hint).toBeTruthy()
    }
    expect(new Set(PERMISSION_OPTIONS.map((item) => item.label)).size).toBe(3)
  })

  it('说明里点明「黑名单仍然问」:唯一在任何档位都拦得住的闸门必须写在完全访问那句里', () => {
    const full = PERMISSION_OPTIONS.find((item) => item.value === 'full')
    expect(full?.hint).toContain('黑名单')
  })
})
