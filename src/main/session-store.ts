import { randomUUID } from 'node:crypto'
import type { EntryDetail, EntryMeta, HeaderPair, TimingInfo } from '../shared/types'
import { renderBody } from './body'

export interface TransactionInit {
  method: string
  url: string
  host: string
  port: number
  path: string
  protocol: 'http' | 'https'
  clientIp: string
  tunnel?: boolean
  note?: string
  repeatOf?: string
  httpVersion?: string
}

export interface StoredTransaction {
  meta: EntryMeta
  requestHeaders: HeaderPair[]
  responseHeaders: HeaderPair[]
  requestHeaderSize: number
  responseHeaderSize: number
  requestChunks: Buffer[]
  responseChunks: Buffer[]
  requestBody: Buffer | null
  responseBody: Buffer | null
  requestBodySize: number
  responseBodySize: number
  requestTruncated: boolean
  responseTruncated: boolean
  requestEncoding?: string
  responseEncoding?: string
  timings: TimingInfo
  httpVersion: string
}

export interface SessionEntryData {
  meta: EntryMeta
  requestHeaders: HeaderPair[]
  responseHeaders: HeaderPair[]
  requestBodyBase64: string | null
  responseBodyBase64: string | null
  requestBodySize: number
  responseBodySize: number
  requestTruncated: boolean
  responseTruncated: boolean
  requestEncoding?: string
  responseEncoding?: string
  timings: TimingInfo
  httpVersion: string
}

export interface SessionFileData {
  app: string
  version: number
  savedAt: number
  entries: SessionEntryData[]
}

export interface SessionStoreEvents {
  onAdd: (meta: EntryMeta) => void
  onUpdate: (meta: EntryMeta) => void
  onRemove: (id: string) => void
  onClear: () => void
}

/**
 * 抓包会话存储。
 * 请求/响应体以 Buffer 形式保存在主进程，渲染进程只在需要时拉取详情，
 * 避免大量请求时 IPC 数据量过大。
 */
export class SessionStore {
  private items = new Map<string, StoredTransaction>()
  private order: string[] = []
  private seq = 0
  private maxEntries = 3000

  constructor(private readonly events: SessionStoreEvents, maxEntries = 3000) {
    this.maxEntries = maxEntries
  }

  create(init: TransactionInit): StoredTransaction {
    const seq = ++this.seq
    const meta: EntryMeta = {
      id: randomUUID(),
      seq,
      startTime: Date.now(),
      method: init.method.toUpperCase(),
      url: init.url,
      host: init.host,
      port: init.port,
      path: init.path,
      protocol: init.protocol,
      clientIp: init.clientIp,
      state: 'pending',
      requestSize: 0,
      responseSize: 0,
      requestMime: '',
      responseMime: '',
      tunnel: Boolean(init.tunnel),
      note: init.note,
      repeatOf: init.repeatOf
    }
    return {
      meta,
      requestHeaders: [],
      responseHeaders: [],
      requestHeaderSize: 0,
      responseHeaderSize: 0,
      requestChunks: [],
      responseChunks: [],
      requestBody: null,
      responseBody: null,
      requestBodySize: 0,
      responseBodySize: 0,
      requestTruncated: false,
      responseTruncated: false,
      timings: { startedAt: meta.startTime },
      httpVersion: init.httpVersion ?? 'HTTP/1.1'
    }
  }

  /** 请求信息准备完成后加入会话并通知列表 */
  commit(tx: StoredTransaction): EntryMeta {
    if (!this.items.has(tx.meta.id)) {
      this.items.set(tx.meta.id, tx)
      this.order.push(tx.meta.id)
      this.events.onAdd(tx.meta)
      this.trim()
    }
    return tx.meta
  }

  touch(tx: StoredTransaction): void {
    if (this.items.has(tx.meta.id)) this.events.onUpdate(tx.meta)
  }

  finalize(tx: StoredTransaction, state: 'complete' | 'error', error?: string): EntryMeta {
    // 隧道等长连接可能多次触发结束事件，只保留首次结果
    if (tx.timings.totalMs !== undefined) return tx.meta
    const completedAt = Date.now()
    tx.timings.completedAt = completedAt
    tx.timings.totalMs = Math.max(0, completedAt - tx.timings.startedAt)
    tx.requestBody = tx.requestChunks.length ? Buffer.concat(tx.requestChunks) : null
    tx.responseBody = tx.responseChunks.length ? Buffer.concat(tx.responseChunks) : null
    tx.meta.state = state
    tx.meta.error = error
    tx.meta.duration = tx.timings.totalMs
    tx.meta.requestSize = tx.requestHeaderSize + tx.requestBodySize
    tx.meta.responseSize = tx.responseHeaderSize + tx.responseBodySize
    if (state === 'error' && !tx.meta.status && error) tx.meta.note = tx.meta.note || error
    this.touch(tx)
    return tx.meta
  }

  get(id: string): StoredTransaction | undefined {
    return this.items.get(id)
  }

  list(): EntryMeta[] {
    return this.order.map((id) => this.items.get(id)!.meta)
  }

  remove(id: string): void {
    if (!this.items.has(id)) return
    this.items.delete(id)
    this.order = this.order.filter((item) => item !== id)
    this.events.onRemove(id)
  }

  clear(): void {
    this.items.clear()
    this.order = []
    this.events.onClear()
  }

  /** 代理停止时把尚未完成的请求标记为失败，避免列表长期显示 pending */
  failPending(reason: string): void {
    for (const tx of [...this.items.values()]) {
      if (tx.meta.state === 'pending') this.finalize(tx, 'error', reason)
    }
  }

  setMaxEntries(value: number): void {
    this.maxEntries = value
    this.trim()
  }

  private trim(): void {
    while (this.order.length > this.maxEntries) {
      const id = this.order.shift()!
      this.items.delete(id)
      this.events.onRemove(id)
    }
  }

  async toDetail(tx: StoredTransaction): Promise<EntryDetail> {
    const requestBuffer = tx.requestBody ?? (tx.requestChunks.length ? Buffer.concat(tx.requestChunks) : null)
    const responseBuffer = tx.responseBody ?? (tx.responseChunks.length ? Buffer.concat(tx.responseChunks) : null)
    const [requestBody, responseBody] = await Promise.all([
      renderBody(requestBuffer, tx.requestBodySize, tx.requestTruncated, tx.meta.requestMime, tx.requestEncoding),
      renderBody(responseBuffer, tx.responseBodySize, tx.responseTruncated, tx.meta.responseMime, tx.responseEncoding)
    ])
    return {
      ...tx.meta,
      requestHeaders: tx.requestHeaders,
      responseHeaders: tx.responseHeaders,
      requestHeaderSize: tx.requestHeaderSize,
      responseHeaderSize: tx.responseHeaderSize,
      requestBody,
      responseBody,
      timings: { ...tx.timings },
      httpVersion: tx.httpVersion
    }
  }

  exportSession(): SessionFileData {
    const entries = this.order.map((id) => {
      const tx = this.items.get(id)!
      const requestBuffer = tx.requestBody ?? (tx.requestChunks.length ? Buffer.concat(tx.requestChunks) : null)
      const responseBuffer = tx.responseBody ?? (tx.responseChunks.length ? Buffer.concat(tx.responseChunks) : null)
      const entry: SessionEntryData = {
        meta: { ...tx.meta },
        requestHeaders: tx.requestHeaders.map((pair) => [...pair] as HeaderPair),
        responseHeaders: tx.responseHeaders.map((pair) => [...pair] as HeaderPair),
        requestBodyBase64: requestBuffer ? requestBuffer.toString('base64') : null,
        responseBodyBase64: responseBuffer ? responseBuffer.toString('base64') : null,
        requestBodySize: tx.requestBodySize,
        responseBodySize: tx.responseBodySize,
        requestTruncated: tx.requestTruncated,
        responseTruncated: tx.responseTruncated,
        requestEncoding: tx.requestEncoding,
        responseEncoding: tx.responseEncoding,
        timings: { ...tx.timings },
        httpVersion: tx.httpVersion
      }
      return entry
    })
    return { app: 'FakeCharles', version: 1, savedAt: Date.now(), entries }
  }

  importSession(data: SessionFileData): EntryMeta[] {
    if (!data || data.app !== 'FakeCharles' || !Array.isArray(data.entries)) {
      throw new Error('无法识别的会话文件')
    }
    this.items.clear()
    this.order = []
    this.seq = 0
    for (const entry of data.entries) {
      if (!entry?.meta?.id || !entry.meta.url) continue
      const meta = { ...entry.meta }
      if (meta.state === 'pending') {
        meta.state = 'complete'
        meta.note = meta.note || '会话恢复时请求尚未完成'
      }
      this.seq = Math.max(this.seq, meta.seq || 0)
      const tx: StoredTransaction = {
        meta,
        requestHeaders: entry.requestHeaders ?? [],
        responseHeaders: entry.responseHeaders ?? [],
        requestHeaderSize: meta.requestSize ? Math.max(0, meta.requestSize - (entry.requestBodySize ?? 0)) : 0,
        responseHeaderSize: meta.responseSize ? Math.max(0, meta.responseSize - (entry.responseBodySize ?? 0)) : 0,
        requestChunks: [],
        responseChunks: [],
        requestBody: entry.requestBodyBase64 ? Buffer.from(entry.requestBodyBase64, 'base64') : null,
        responseBody: entry.responseBodyBase64 ? Buffer.from(entry.responseBodyBase64, 'base64') : null,
        requestBodySize: entry.requestBodySize ?? 0,
        responseBodySize: entry.responseBodySize ?? 0,
        requestTruncated: Boolean(entry.requestTruncated),
        responseTruncated: Boolean(entry.responseTruncated),
        requestEncoding: entry.requestEncoding,
        responseEncoding: entry.responseEncoding,
        timings: entry.timings ?? { startedAt: meta.startTime },
        httpVersion: entry.httpVersion || 'HTTP/1.1'
      }
      if (!this.items.has(meta.id)) {
        this.items.set(meta.id, tx)
        this.order.push(meta.id)
      }
    }
    // 会话导入由主进程整体广播，无需逐条触发事件
    while (this.order.length > this.maxEntries) {
      const id = this.order.shift()!
      this.items.delete(id)
    }
    return this.list()
  }
}
