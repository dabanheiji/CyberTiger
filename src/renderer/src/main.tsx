// Inter 的 latin 子集(OFL 许可,随包本地引入 —— CSP 禁远端字体)。只取 400/500/600
// 三个静态字重:可变字体约 340KB,这三个加起来约 75KB。汉字不在子集里,按字形回退到
// theme.ts 字体栈里的系统中文字体。
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import './assets/main.css'

// import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  // <StrictMode>
  <App />
  // </StrictMode>
)
