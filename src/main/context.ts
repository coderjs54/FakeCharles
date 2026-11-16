import type { BrowserWindow } from 'electron'
import type { AppCommand, SystemProxyState } from '../shared/types'
import type { CaptureProxy } from './proxy-server'
import type { SessionStore } from './session-store'
import type { SettingsStore } from './settings'
import type { SystemProxyManager } from './system-proxy'

export interface MainContext {
  getWindow: () => BrowserWindow | null
  store: SessionStore
  proxy: CaptureProxy
  settings: SettingsStore
  systemProxy: SystemProxyManager
  broadcast: (channel: string, payload?: unknown) => void
  sendCommand: (command: AppCommand) => void
  /** 根据代理运行状态与设置，重新应用或恢复系统代理 */
  syncSystemProxy: () => SystemProxyState
}
