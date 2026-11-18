/** 请求/响应头键值对（保留重复头，如 Set-Cookie） */
export type HeaderPair = [string, string]

export type EntryState = 'pending' | 'complete' | 'error'

/** 列表行使用的轻量元数据，主进程会通过 IPC 增量推送给渲染进程 */
export interface EntryMeta {
  id: string
  /** 会话内自增序号 */
  seq: number
  /** 请求开始时间（毫秒时间戳） */
  startTime: number
  method: string
  /** 完整 URL */
  url: string
  /** 主机名（不含端口） */
  host: string
  port: number
  /** pathname + search */
  path: string
  protocol: 'http' | 'https'
  clientIp: string
  status?: number
  statusText?: string
  state: EntryState
  error?: string
  /** 请求头 + 请求体字节数 */
  requestSize: number
  /** 响应头 + 响应体字节数 */
  responseSize: number
  /** 耗时（毫秒） */
  duration?: number
  requestMime: string
  responseMime: string
  /** 是否为 HTTPS CONNECT 隧道（未解密） */
  tunnel: boolean
  /** 是否为通过本地 CA 解密后的 HTTPS 请求 */
  decrypted?: boolean
  /** 是否为 WebSocket / Upgrade 连接（仅透传，不解析帧） */
  upgrade?: boolean
  note?: string
  /** 若为重放请求，指向原请求 id */
  repeatOf?: string
}

export interface BodyView {
  available: boolean
  /** 网络传输的字节数 */
  size: number
  /** 实际捕获到的字节数 */
  capturedSize: number
  /** 解码后字节数 */
  decodedSize: number
  /** 捕获是否被大小限制截断 */
  truncated: boolean
  /** 文本展示是否因过长被截断 */
  textTruncated: boolean
  kind: 'empty' | 'text' | 'binary'
  mime: string
  encoding?: string
  text?: string
  base64?: string
  decodeError?: string
  /** 大 Body 被延迟加载，渲染进程需要通过 getEntryBody 单独拉取 */
  deferred?: boolean
}

export interface TimingInfo {
  startedAt: number
  firstByteAt?: number
  completedAt?: number
  /** 收到首字节前的等待耗时 */
  waitMs?: number
  /** 接收响应体耗时 */
  receiveMs?: number
  totalMs?: number
}

/** 详情面板数据（按需请求，避免列表 IPC 过大） */
export interface EntryDetail extends EntryMeta {
  requestHeaders: HeaderPair[]
  responseHeaders: HeaderPair[]
  requestHeaderSize: number
  responseHeaderSize: number
  requestBody: BodyView
  responseBody: BodyView
  timings: TimingInfo
  httpVersion: string
}

export interface ProxyStatus {
  running: boolean
  /** 供用户配置的代理地址（本机或局域网 IP） */
  host: string
  port: number
  recording: boolean
  error?: string
  startedAt?: number
}

export interface AppSettings {
  proxyPort: number
  autoStartProxy: boolean
  /** 允许局域网设备连接（绑定 0.0.0.0） */
  allowLan: boolean
  /** 启动代理时自动接管 Windows 系统代理，退出时恢复 */
  autoSystemProxy: boolean
  /** 是否已就「自动接管系统代理」征求过用户同意 */
  systemProxyPrompted: boolean
  /** 是否启用本地 CA，对 HTTPS 做 TLS 中间人解密 */
  decryptHttps: boolean
  /** 是否忽略代理到上游服务器的 TLS 证书错误（仅调试自签名/内部站点） */
  allowInsecureUpstream: boolean
  /** 是否通过上游 HTTP 代理转发请求（企业网络场景） */
  upstreamProxyEnabled: boolean
  /** 上游代理地址，例如 http://user:pass@proxy.company.com:8080 */
  upstreamProxyUrl: string
  /** 单个请求/响应体最大捕获字节数 */
  maxBodySize: number
  /** 会话最大保留条目数 */
  maxEntries: number
  /** 是否记录 HTTPS CONNECT 隧道（只显示提示，不抓内容） */
  recordTunnels: boolean
}

/** Windows 系统代理自动配置状态 */
export interface SystemProxyState {
  supported: boolean
  active: boolean
  /** 当前接管的地址，例如 127.0.0.1:8888 */
  server: string
  error?: string
}

/** 本地 HTTPS 解密根证书状态 */
export interface HttpsCaInfo {
  /** 当前平台是否支持生成/安装（生成跨平台可用） */
  supported: boolean
  /** 是否可以通过应用一键安装到系统信任存储 */
  installable: boolean
  generated: boolean
  certPath?: string
  certPem?: string
  platform: NodeJS.Platform
  message?: string
  error?: string
}

export interface ComposePayload {
  method: string
  url: string
  /** 多行 "Name: value" 文本 */
  headers: string
  body: string
}

export type AppCommand =
  | 'clear-session'
  | 'open-settings'
  | 'compose'
  | 'save-session'
  | 'open-session'
  | 'export-har'
  | 'toggle-recording'
  | 'toggle-proxy'
  | 'focus-filter'
  | 'copy-proxy'
  | 'about'

/** 主进程 <-> 渲染进程的 IPC 通道名 */
export const IPC = {
  proxyStart: 'proxy:start',
  proxyStop: 'proxy:stop',
  proxyStatus: 'proxy:status',
  proxyRecording: 'proxy:recording',
  sessionList: 'session:list',
  sessionClear: 'session:clear',
  sessionRemove: 'session:remove',
  sessionEntry: 'session:entry',
  sessionBody: 'session:body',
  sessionRepeat: 'session:repeat',
  sessionCompose: 'session:compose',
  sessionSave: 'session:save',
  sessionOpen: 'session:open',
  sessionHar: 'session:har',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  systemProxyGet: 'system-proxy:get',
  httpsCaInfo: 'https-ca:info',
  httpsCaEnsure: 'https-ca:ensure',
  httpsCaInstall: 'https-ca:install',
  httpsCaReveal: 'https-ca:reveal',
  clipboardWrite: 'clipboard:write',
  bodySave: 'body:save',
  eventEntry: 'event:entry',
  eventEntryUpdate: 'event:entry-update',
  eventEntryRemove: 'event:entry-remove',
  eventClear: 'event:clear',
  eventLoaded: 'event:loaded',
  eventStatus: 'event:status',
  eventSettings: 'event:settings',
  eventSystemProxy: 'event:system-proxy',
  eventCommand: 'event:command',
  eventError: 'event:error'
} as const
