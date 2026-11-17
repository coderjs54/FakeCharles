import { app, BrowserWindow, shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { APP_NAME } from '../shared/defaults'
import { IPC, type AppCommand, type SystemProxyState } from '../shared/types'
import { CertificateAuthority } from './cert-manager'
import type { MainContext } from './context'
import { registerIpc } from './ipc'
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
    settings.get().autoSystemProxy && proxy.getStatus().running
      ? systemProxy.apply(proxy.getStatus().port)
      : systemProxy.restore()

  broadcast(IPC.eventSystemProxy, state)
  if (state.error) console.error(`[${APP_NAME}] ${state.error}`)
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
    backgroundColor: '#f4f6f9',
    title: `${APP_NAME} — HTTP 抓包代理`,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
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

  settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'))
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
      onStatus: (status) => broadcast(IPC.eventStatus, status),
      onError: (message) => console.error(`[${APP_NAME}] ${message}`),
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
      allowInsecureUpstream: settings.get().allowInsecureUpstream
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
          console.error('[selftest] failed:', error)
          setTimeout(() => app.exit(1), 100)
        })
    })
    return
  }

  if (settings.get().autoStartProxy) {
    proxy.start().catch((error: Error) => {
      console.error(`[${APP_NAME}] auto start proxy failed: ${error.message}`)
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

  app.whenReady().then(bootstrap).catch((error) => {
    console.error(error)
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
  })
}
