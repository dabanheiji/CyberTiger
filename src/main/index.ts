import { app, shell, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpc } from './ipc'
import { abortAll } from './chat/service'
import { initMcp } from './mcp/controller'
import { mcpManager } from './mcp/manager'
import { initSkills } from './skills/controller'
import { initAgents } from './agents/controller'
import { migrateSettings } from './store/migrate'
import { store } from './store'
import { applyThemeSource } from './appearance'
import { engineProbe } from './sandbox/preflight'
import { loadWindowState, trackWindowState } from './window-state'

/**
 * 顶栏预留高度。与 renderer `main.css` 的 `--cybertiger-titlebar-inset` 同值 ——
 * 跨进程没有共享常量,改一处要改两处。
 */
const TITLEBAR_HEIGHT = 38

/** 窗口底色与顶栏配色。三个值取自 theme.ts 的 colorBgLayout / colorBgContainer / colorTextBase */
function chromeColors(dark: boolean): { background: string; container: string; text: string } {
  return dark
    ? { background: '#161513', container: '#1F1E1B', text: '#F0EDE6' }
    : { background: '#F5F4F1', container: '#FFFFFF', text: '#211F1C' }
}

/**
 * 标题栏交回系统画:mac 用 hiddenInset 保留红绿灯(嵌进内容区),win/linux 用叠层画窗口按钮。
 * 不自绘按钮,所以读屏、高对比度主题与 Win11 贴靠布局都仍由系统负责,也不新增任何 window:* IPC。
 */
function titleBarOptions(): Electron.BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset' }
  const colors = chromeColors(nativeTheme.shouldUseDarkColors)
  return {
    titleBarStyle: 'hidden',
    // 叠层压在聊天画布那一列的上沿,底色取 colorBgContainer 才看不出接缝
    titleBarOverlay: {
      color: colors.container,
      symbolColor: colors.text,
      height: TITLEBAR_HEIGHT
    }
  }
}

function createWindow(): void {
  // 上次退出时的窗口大小/位置;没有记录时用默认尺寸
  const state = loadWindowState()

  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    show: false,
    autoHideMenuBar: true,
    // 首帧底色:React 挂载前露出的是窗口底色,深色主题下不指定就会闪一下白
    backgroundColor: chromeColors(nativeTheme.shouldUseDarkColors).background,
    ...titleBarOptions(),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  trackWindowState(mainWindow)

  // 运行中切系统主题:底色与 win/linux 的按钮叠层都得跟着换,否则顶栏留一条旧色的带
  nativeTheme.on('updated', () => {
    if (mainWindow.isDestroyed()) return
    const colors = chromeColors(nativeTheme.shouldUseDarkColors)
    mainWindow.setBackgroundColor(colors.background)
    if (process.platform !== 'darwin') {
      mainWindow.setTitleBarOverlay({
        color: colors.container,
        symbolColor: colors.text,
        height: TITLEBAR_HEIGHT
      })
    }
  })

  mainWindow.on('ready-to-show', () => {
    // 先还原最大化再显示,避免先闪一下普通尺寸
    if (state.isMaximized) mainWindow.maximize()
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))
  // 先迁移配置结构,后面的初始化与窗口都按新结构读
  migrateSettings()
  // 明暗模式必须早于建窗:窗口底色与 win/linux 的顶栏叠层读的就是 shouldUseDarkColors,
  // 晚设会先闪一下系统配色的底
  applyThemeSource(store.get('appearance')?.mode)

  registerIpc()
  initMcp()
  initSkills()
  initAgents()

  createWindow()

  // 预热受限执行的引擎探针:那是一次 100–500ms 的 spawn,不该出现在「按下发送」的路径上。
  // 结论在进程内不刷新,所以中途装了 bwrap 要重启应用才认(设置页那一栏明写这一句)。
  void engineProbe()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 退出前中止所有进行中的模型请求,避免数据库关闭后仍在写入;并关闭 MCP 子进程
app.on('before-quit', () => {
  abortAll()
  void mcpManager.closeAll()
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
