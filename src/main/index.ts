import { app, BrowserWindow, nativeTheme, session, shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { APP_NAME, APP_VERSION } from '../shared/defaults'
import { IPC, type AppCommand, type SystemProxyState } from '../shared/types'
import { CertificateAuthority } from './cert-manager'
import type { MainContext } from './context'
import { registerIpc } from './ipc'
import { initLogger, logError, logInfo } from './logger'
import { installApplicationMenu } from './menu'
import { CaptureProxy } from './proxy-server'
import { runSelfTest } from './selftest'
import { SessionStore } from './session-store'
import { SettingsStore } from './settings'
import { SystemProxyManager } from './system-proxy'

const IS_SELFTEST = process.argv.includes('--selftest') || process.env.FC_SELFTEST === '1'

if (IS_SELFTEST) {
  app.disableHardwareAcceleration()
  // 自测使用独立 userData，避免与正在运行的开发实例抢单实例锁/缓存
  const selftestUserData = join(process.cwd(), '.selftest', 'user-data')
  mkdirSync(selftestUserData, { recursive: true })
  app.setPath('userData', selftestUserData)
}

let mainWindow: BrowserWindow | null = null
let settings: SettingsStore
let store: SessionStore
let proxy: CaptureProxy
let systemProxy: SystemProxyManager
let certificateAuthority: CertificateAuthority

// 兜底记录主进程未捕获异常，用户可通过「帮助 → 导出诊断信息」反馈
process.on('uncaughtException', (error) => logError('未捕获异常', error))
process.on('unhandledRejection', (reason) => logError('未处理的 Promise 拒绝', reason))

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(channel, payload)
    } catch {
      // 窗口正在销毁时忽略发送错误
    }
  }
}

function sendCommand(command: AppCommand): void {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow
  if (win && !win.isDestroyed()) win.webContents.send(IPC.eventCommand, command)
}

/** 根据「代理是否运行 + 是否允许自动接管」同步 Windows 系统代理 */
function syncSystemProxy(): SystemProxyState {
  if (!settings || !proxy || !systemProxy) {
    return { supported: false, active: false, server: '' }
  }
  if (IS_SELFTEST) return systemProxy.getStatus()

  const state =
    settings.get().autoSystemProxy && settings.get().systemProxyPrompted && proxy.getStatus().running
      ? systemProxy.apply(proxy.getStatus().port)
      : systemProxy.restore()

  broadcast(IPC.eventSystemProxy, state)
  if (state.error) logError(state.error)
  return state
}

/** 查找应用图标；开发环境从项目 resources 读取，打包后从 resourcesPath 读取 */
function getWindowIconPath(): string | undefined {
  const names = process.platform === 'win32' ? ['icon.ico', 'icon.png'] : ['icon.png']
  const roots = app.isPackaged
    ? [process.resourcesPath, join(process.cwd(), 'resources')]
    : [join(process.cwd(), 'resources'), join(__dirname, '../../resources')]

  for (const root of roots) {
    for (const name of names) {
      const candidate = join(root, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function createWindow(): BrowserWindow {
  const iconPath = getWindowIconPath()
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1040,
    minHeight: 640,
    show: false,
    // 窗口底色跟随主题，避免暗黑模式下启动瞬间闪白
    backgroundColor: settings?.get().theme === 'dark' ? '#12161d' : '#f4f6f9',
    title: `${APP_NAME} — HTTP 抓包代理`,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  if (iconPath) win.setIcon(iconPath)
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  if (process.env.FC_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' })
  mainWindow = win
  return win
}

async function bootstrap(): Promise<void> {
  app.setName(APP_NAME)
  app.setAppUserModelId('com.fakecharles.app')

  // 日志目录位于 userData 下，自测环境会自动落到 .selftest/user-data/logs
  initLogger(join(app.getPath('userData'), 'logs'))
  logInfo(`应用启动 v${APP_VERSION} · Electron ${process.versions.electron} · ${process.platform} ${process.arch}`)

  // 渲染进程不需要摄像头、麦克风、地理位置、通知等 Web 权限，统一拒绝
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)

  settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'))
  // 让标题栏、菜单和原生控件跟随应用内主题
  nativeTheme.themeSource = settings.get().theme
  // 自测环境不弹出系统代理接管确认，避免阻塞自动化流程
  if (IS_SELFTEST && !settings.get().systemProxyPrompted) {
    settings.update({ systemProxyPrompted: true })
  }
  systemProxy = new SystemProxyManager(join(app.getPath('userData'), 'system-proxy-backup.json'))
  certificateAuthority = new CertificateAuthority(join(app.getPath('userData'), 'https-ca'))

  // 上次运行如果是崩溃退出，先把系统代理恢复成用户原值
  if (!IS_SELFTEST) systemProxy.recover()

  store = new SessionStore(
    {
      onAdd: (meta) => broadcast(IPC.eventEntry, meta),
      onUpdate: (meta) => broadcast(IPC.eventEntryUpdate, meta),
      onRemove: (id) => broadcast(IPC.eventEntryRemove, id),
      onClear: () => broadcast(IPC.eventClear)
    },
    settings.get().maxEntries
  )
  proxy = new CaptureProxy(
    store,
    {
      onStatus: (status) => {
        broadcast(IPC.eventStatus, status)
        logInfo(status.running ? `代理已启动：${status.host}:${status.port}` : '代理已停止')
      },
      onError: (message) => {
        logError(message)
        // 把运行期错误同步给界面，避免只写日志导致用户无从排查
        broadcast(IPC.eventError, message)
      },
      onLifecycle: () => {
        syncSystemProxy()
      }
    },
    {
      port: settings.get().proxyPort,
      allowLan: settings.get().allowLan,
      maxBodySize: settings.get().maxBodySize,
      recordTunnels: settings.get().recordTunnels,
      recording: true,
      decryptHttps: settings.get().decryptHttps,
      allowInsecureUpstream: settings.get().allowInsecureUpstream,
      upstreamProxyUrl: settings.get().upstreamProxyEnabled ? settings.get().upstreamProxyUrl : ''
    },
    certificateAuthority
  )

  const ctx: MainContext = {
    getWindow: () => mainWindow,
    store,
    proxy,
    settings,
    systemProxy,
    broadcast,
    sendCommand,
    syncSystemProxy
  }

  registerIpc(ctx)
  installApplicationMenu(ctx)

  const win = createWindow()

  if (IS_SELFTEST) {
    win.webContents.once('did-finish-load', () => {
      win.show()
      runSelfTest({ window: win, proxy, store, ca: certificateAuthority, rootDir: process.cwd() })
        .then((code) => {
          setTimeout(() => app.exit(code), 100)
        })
        .catch((error) => {
          logError('自测执行失败', error)
          setTimeout(() => app.exit(1), 100)
        })
    })
    return
  }

  if (settings.get().autoStartProxy) {
    proxy.start().catch((error: Error) => {
      logError('自动启动代理失败', error)
    })
  }
}

const gotLock = IS_SELFTEST ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app
    .whenReady()
    .then(bootstrap)
    .catch((error) => {
      logError('应用启动失败', error)
      app.quit()
    })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    // 先恢复系统代理，再关闭本地监听，避免退出后浏览器还指向已关闭的端口
    if (systemProxy) systemProxy.restore()
    if (proxy) void proxy.stop(true)
    logInfo('应用退出')
  })
}
