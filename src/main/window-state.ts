import { screen, type BrowserWindow, type Rectangle } from 'electron'
import { store } from './store'
import type { WindowState } from './store/types'

/** 首次启动或记录失效时的默认尺寸 */
const DEFAULT_SIZE = { width: 900, height: 670 }
/** 尺寸下限,避免脏数据把窗口缩到不可用 */
const MIN_SIZE = { width: 400, height: 300 }
/** move / resize 拖拽期间高频触发,落盘防抖 */
const SAVE_DELAY_MS = 300

/** 宽高必须是有限值且不小于下限 */
function isUsableBounds(bounds: Rectangle): boolean {
  return (
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width >= MIN_SIZE.width &&
    bounds.height >= MIN_SIZE.height
  )
}

/** 窗口是否与匹配显示器的工作区有交集;外接屏拔掉后旧坐标会落到屏幕外 */
function isOnScreen(bounds: Rectangle): boolean {
  const area = screen.getDisplayMatching(bounds).workArea
  const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
  const overlapY =
    Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)
  return overlapX > 0 && overlapY > 0
}

/** 读取上次窗口状态;数据缺失、非法或位置已失效时逐项回退默认值 */
export function loadWindowState(): {
  width: number
  height: number
  x?: number
  y?: number
  isMaximized: boolean
} {
  const saved = store.get('windowState')
  if (!saved || !isUsableBounds(saved.bounds as Rectangle)) {
    return { ...DEFAULT_SIZE, isMaximized: false }
  }

  const bounds = saved.bounds as Rectangle
  return {
    width: bounds.width,
    height: bounds.height,
    // 位置失效时只保留尺寸,由系统决定位置
    ...(isOnScreen(bounds) ? { x: bounds.x, y: bounds.y } : {}),
    isMaximized: saved.isMaximized === true
  }
}

/**
 * 跟踪窗口大小/位置并持久化。
 * 最大化时记录还原后的尺寸(getNormalBounds)与标记,而不是最大化后的尺寸。
 */
export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null

  const save = (): void => {
    if (win.isDestroyed()) return
    const state: WindowState = {
      bounds: win.getNormalBounds(),
      isMaximized: win.isMaximized()
    }
    store.set('windowState', state)
  }

  const scheduleSave = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, SAVE_DELAY_MS)
  }

  win.on('resize', scheduleSave)
  win.on('move', scheduleSave)
  win.on('maximize', scheduleSave)
  win.on('unmaximize', scheduleSave)
  // 关闭前落盘最终状态,避免防抖窗口内的改动丢失
  win.on('close', () => {
    if (timer) clearTimeout(timer)
    save()
  })
}
