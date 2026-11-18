import type {
  AppCommand,
  AppSettings,
  BodyView,
  ComposePayload,
  EntryDetail,
  EntryMeta,
  HttpsCaInfo,
  ProxyStatus,
  SystemProxyState
} from './types'

export interface SaveResult {
  path: string
  count: number
}

export interface SaveBodyResult {
  path: string
  size: number
}

/** preload 暴露给渲染进程的 API */
export interface FakeCharlesApi {
  startProxy: (port?: number) => Promise<ProxyStatus>
  stopProxy: () => Promise<ProxyStatus>
  getProxyStatus: () => Promise<ProxyStatus>
  setRecording: (recording: boolean) => Promise<ProxyStatus>
  listEntries: () => Promise<EntryMeta[]>
  clearSession: () => Promise<void>
  removeEntry: (id: string) => Promise<void>
  getEntry: (id: string, lazyBodies?: boolean) => Promise<EntryDetail | null>
  getEntryBody: (id: string, side: 'request' | 'response') => Promise<BodyView | null>
  repeatEntry: (id: string) => Promise<EntryMeta>
  compose: (payload: ComposePayload) => Promise<EntryMeta>
  saveSession: () => Promise<SaveResult | null>
  openSession: () => Promise<SaveResult | null>
  exportHar: () => Promise<SaveResult | null>
  getSettings: () => Promise<AppSettings>
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  getSystemProxy: () => Promise<SystemProxyState>
  getHttpsCaInfo: () => Promise<HttpsCaInfo>
  ensureHttpsCa: () => Promise<HttpsCaInfo>
  installHttpsCa: () => Promise<HttpsCaInfo>
  revealHttpsCa: () => Promise<HttpsCaInfo>
  copyText: (text: string) => Promise<void>
  saveBody: (payload: { id: string; side: 'request' | 'response' }) => Promise<SaveBodyResult | null>
  onEntry: (callback: (meta: EntryMeta) => void) => () => void
  onEntryUpdate: (callback: (meta: EntryMeta) => void) => () => void
  onEntryRemove: (callback: (id: string) => void) => () => void
  onClear: (callback: () => void) => () => void
  onLoaded: (callback: (metas: EntryMeta[]) => void) => () => void
  onStatus: (callback: (status: ProxyStatus) => void) => () => void
  onSettings: (callback: (settings: AppSettings) => void) => () => void
  onSystemProxy: (callback: (state: SystemProxyState) => void) => () => void
  onCommand: (callback: (command: AppCommand) => void) => () => void
  onError: (callback: (message: string) => void) => () => void
}
