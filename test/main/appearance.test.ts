import { nativeTheme } from 'electron'
import { applyThemeSource } from '../../src/main/appearance'

/**
 * `applyThemeSource` 唯一的风险是「把 undefined 当成某种覆盖」——那会让启动时没配过外观的
 * 应用停在最后一次手动模式上。所以未设置必须落回 `'system'`,而不是什么都不做。
 */
describe('applyThemeSource', () => {
  it('明暗两档各自写成同名的 themeSource', () => {
    applyThemeSource('light')
    expect(nativeTheme.themeSource).toBe('light')
    applyThemeSource('dark')
    expect(nativeTheme.themeSource).toBe('dark')
  })

  it('未设置与 system 都回到跟随系统', () => {
    applyThemeSource('dark')
    applyThemeSource(undefined)
    expect(nativeTheme.themeSource).toBe('system')
    applyThemeSource('light')
    applyThemeSource('system')
    expect(nativeTheme.themeSource).toBe('system')
  })
})
