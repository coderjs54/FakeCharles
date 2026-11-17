import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { FakeCharlesApi } from '../shared/api'
import {
  IPC,
  type AppCommand,
  type AppSettings,
  type ComposePayload,
  type EntryDetail,
  type EntryMeta,
  type HttpsCaInfo,
  type ProxyStatus,
  type SystemProxyState
} from '../shared/types'

/** 注册事件监听并返回取消订阅函数，避免渲染进程重复绑定 */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: FakeCharlesApi = {
  startProxy: (port?: number) => ipcRenderer.invoke(IPC.proxyStart, port) as Promise<ProxyStatus>,
  stopProxy: () => ipcRenderer.invoke(IPC.proxyStop) as Promise<ProxyStatus>,
  getProxyStatus: () => ipcRenderer.invoke(IPC.proxyStatus) as Promise<ProxyStatus>,
  setRecording: (recording: boolean) => ipcRenderer.invoke(IPC.proxyRecording, recording) as Promise<ProxyStatus>,
  listEntries: () => ipcRenderer.invoke(IPC.sessionList) as Promise<EntryMeta[]>,
  clearSession: () => ipcRenderer.invoke(IPC.sessionClear) as Promise<void>,
  removeEntry: (id: string) => ipcRenderer.invoke(IPC.sessionRemove, id) as Promise<void>,
  getEntry: (id: string) => ipcRenderer.invoke(IPC.sessionEntry, id) as Promise<EntryDetail | null>,
  repeatEntry: (id: string) => ipcRenderer.invoke(IPC.sessionRepeat, id) as Promise<EntryMeta>,
  compose: (payload: ComposePayload) => ipcRenderer.invoke(IPC.sessionCompose, payload) as Promise<EntryMeta>,
  saveSession: () => ipcRenderer.invoke(IPC.sessionSave),
  openSession: () => ipcRenderer.invoke(IPC.sessionOpen),
  exportHar: () => ipcRenderer.invoke(IPC.sessionHar),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<AppSettings>,
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.settingsUpdate, patch) as Promise<AppSettings>,
  getSystemProxy: () => ipcRenderer.invoke(IPC.systemProxyGet) as Promise<SystemProxyState>,
  getHttpsCaInfo: () => ipcRenderer.invoke(IPC.httpsCaInfo) as Promise<HttpsCaInfo>,
  ensureHttpsCa: () => ipcRenderer.invoke(IPC.httpsCaEnsure) as Promise<HttpsCaInfo>,
  installHttpsCa: () => ipcRenderer.invoke(IPC.httpsCaInstall) as Promise<HttpsCaInfo>,
  revealHttpsCa: () => ipcRenderer.invoke(IPC.httpsCaReveal) as Promise<HttpsCaInfo>,
  copyText: (text: string) => ipcRenderer.invoke(IPC.clipboardWrite, text) as Promise<void>,
  saveBody: (payload: { id: string; side: 'request' | 'response' }) => ipcRenderer.invoke(IPC.bodySave, payload),
  onEntry: (callback: (meta: EntryMeta) => void) => subscribe(IPC.eventEntry, callback),
  onEntryUpdate: (callback: (meta: EntryMeta) => void) => subscribe(IPC.eventEntryUpdate, callback),
  onEntryRemove: (callback: (id: string) => void) => subscribe(IPC.eventEntryRemove, callback),
  onClear: (callback: () => void) => subscribe(IPC.eventClear, callback),
  onLoaded: (callback: (metas: EntryMeta[]) => void) => subscribe(IPC.eventLoaded, callback),
  onStatus: (callback: (status: ProxyStatus) => void) => subscribe(IPC.eventStatus, callback),
  onSettings: (callback: (settings: AppSettings) => void) => subscribe(IPC.eventSettings, callback),
  onSystemProxy: (callback: (state: SystemProxyState) => void) => subscribe(IPC.eventSystemProxy, callback),
  onCommand: (callback: (command: AppCommand) => void) => subscribe(IPC.eventCommand, callback)
}

contextBridge.exposeInMainWorld('api', api)
