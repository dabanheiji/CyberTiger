import { nativeTheme } from 'electron'
import type { ThemeMode } from './store/types'

/**
 * 把设置里的明暗模式写进 `nativeTheme.themeSource`。
 *
 * 为什么单独一个叶子模块:调用点有两个 —— 启动时(`main/index.ts`)与写入时
 * (`store/controller.ts`),后者若从 `main/index.ts` 导入会形成
 * index → ipc → controller → index 的循环。
 *
 * 为什么用 themeSource 而不是渲染层自己判断:它是唯一能同时翻转
 * `prefers-color-scheme`(main.css 与 index.html 的深色 media query)与
 * `shouldUseDarkColors`(窗口底色、顶栏叠层)的开关,于是那四条读系统的链路
 * 一行都不用改就跟着手动设置走。
 */
export function applyThemeSource(mode: ThemeMode | undefined): void {
  nativeTheme.themeSource = mode ?? 'system'
}
