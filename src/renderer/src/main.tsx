// Inter 的 latin 子集(OFL 许可,随包本地引入 —— CSP 禁远端字体)。只取 400/500/600
// 三个静态字重:可变字体约 340KB,这三个加起来约 75KB。汉字不在子集里,按字形回退到
// theme.ts 字体栈里的系统中文字体。
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
// Markdown 官方主题:两套都引入,由 Markdown 组件按明暗挂 x-markdown-light / dark。
// 放在应用样式之前 —— 第三方样式先、应用样式后,需要覆盖时顺序天然站在我们这边。
import '@ant-design/x-markdown/themes/light.css'
import '@ant-design/x-markdown/themes/dark.css'
// xterm 的结构样式(逐行定位、选区层、滚动区)。放在应用样式之前,覆盖时顺序站我们这边。
import '@xterm/xterm/css/xterm.css'
import './assets/main.css'

// import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

/**
 * 最后一道恢复网。
 *
 * ErrorBoundary 接得住 React 交给边界处理的渲染 / 提交期异常;但若异常直接从根调度器里
 * 抛出去,React 会把整棵树卸载、再把错误报给 window —— 界面上只剩一个空 #root。
 * 这一层只在「根确实空了」时动手:画一页最朴素的说明加一颗重新加载,
 * 不让人面对一个点不动的空白窗口。它挂在 body 上而不是 root 里,React 永远碰不到它。
 */
function showFatalScreen(): void {
  const root = document.getElementById('root')
  // 根里还有内容(错误被某一层边界接住了)就不该盖上来
  if (!root || root.childElementCount > 0) return
  if (document.getElementById('cybertiger-fatal')) return

  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const page = document.createElement('div')
  page.id = 'cybertiger-fatal'
  page.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:9999',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'padding:24px',
    `background:${dark ? '#141414' : '#f5f5f5'}`,
    `color:${dark ? 'rgba(255,255,255,0.88)' : 'rgba(0,0,0,0.88)'}`,
    'font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
  ].join(';')

  const card = document.createElement('div')
  card.style.cssText = [
    'max-width:420px',
    'width:100%',
    'padding:28px',
    'border-radius:8px',
    `background:${dark ? '#1f1f1f' : '#ffffff'}`,
    `box-shadow:0 6px 24px ${dark ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.08)'}`
  ].join(';')

  const title = document.createElement('div')
  title.textContent = '界面没能渲染出来'
  title.style.cssText = 'font-size:16px;font-weight:600;line-height:24px'

  const text = document.createElement('div')
  text.textContent =
    '渲染时出了意外，应用界面已经被卸载。重新加载即可恢复使用，已保存的对话不会丢失。'
  text.style.cssText = [
    'margin-top:8px',
    'font-size:13px',
    'line-height:22px',
    `color:${dark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)'}`
  ].join(';')

  const reload = document.createElement('button')
  reload.type = 'button'
  reload.textContent = '重新加载'
  reload.style.cssText = [
    'margin-top:20px',
    'padding:6px 20px',
    'border:none',
    'border-radius:6px',
    'cursor:pointer',
    'font-size:14px',
    'line-height:22px',
    `background:${dark ? '#ffffff' : '#141414'}`,
    `color:${dark ? '#141414' : '#ffffff'}`,
    'font-family:inherit'
  ].join(';')
  reload.addEventListener('click', () => window.location.reload())

  card.append(title, text, reload)
  page.append(card)
  document.body.append(page)

  // 若 React 之后又渲染出了内容(错误只坏掉某一轮),把恢复页撤掉,别挡着应用
  const observer = new MutationObserver(() => {
    if (root.childElementCount > 0) {
      observer.disconnect()
      page.remove()
    }
  })
  observer.observe(root, { childList: true })
}

// React 19 对无人接住的错误会先卸载根、再报给 window。
// 不能只靠 requestAnimationFrame:窗口被遮挡或最小化时它会被 Chromium 暂停
// (实测 visibilityState 为 hidden 时 500ms 不触发),后台崩掉就永远等不到恢复页。
// 所以同步先看一次根是不是已经空了,rAF 只作为「报错早于卸载」那一支的补看。
window.addEventListener('error', () => {
  showFatalScreen()
  setTimeout(showFatalScreen, 0)
  requestAnimationFrame(showFatalScreen)
})

createRoot(document.getElementById('root')!).render(
  // <StrictMode>
  <App />
  // </StrictMode>
)
