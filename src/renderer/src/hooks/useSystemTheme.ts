import { useEffect, useState } from 'react'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** 跟随系统外观，返回当前是否为深色模式 */
export function useSystemTheme(): boolean {
  const [isDark, setIsDark] = useState(() => window.matchMedia(DARK_QUERY).matches)

  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY)
    const onChange = (e: MediaQueryListEvent): void => setIsDark(e.matches)
    media.addEventListener('change', onChange)
    return (): void => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    // 让原生滚动条、表单控件等也跟随主题
    document.documentElement.style.colorScheme = isDark ? 'dark' : 'light'
  }, [isDark])

  return isDark
}
