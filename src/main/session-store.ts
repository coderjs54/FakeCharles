import { randomUUID } from 'node:crypto'
import type { BodyView, EntryDetail, EntryMeta, HeaderPair, TimingInfo } from '../shared/types'
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
  decrypted?: boolean
  upgrade?: boolean
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
  /** 实际捕获到内存的请求/响应体字节数（受单 Body 上限截断） */
  requestCapturedSize: number
  responseCapturedSize: number
  requestTruncated: boolean
  responseTruncated: boolean
  requestEncoding?: string
  responseEncoding?: string
  timings: TimingInfo
  httpVersion: string
  /** 已完成条目的 Body 展示缓存，避免详情面板重复解压 */
  bodyViewCache?: BodyViewCache
  /** 正在生成缓存时复用同一个 Promise，避免并发重复解压 */
  bodyViewPromises?: BodyViewPromises
}

interface BodyViewCache {
  request?: BodyView
  response?: BodyView
}

interface BodyViewPromises {
  request?: Promise<BodyView>
  response?: Promise<BodyView>
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

/** 默认会话内容内存预算：256 MB；长会话或大 Body 下自动淘汰最旧记录 */
const DEFAULT_MAX_SESSION_BYTES = 256 * 1024 * 1024

/** Body 展示缓存上限：超过该大小的条目不做缓存，避免和原始 Buffer 重复占用内存 */
const MAX_CACHED_BODY_BYTES = 512 * 1024

/** 详情接口中超过该大小的 Body 先返回占位，由渲染进程按需拉取 */
export const LAZY_BODY_THRESHOLD = 512 * 1024

export interface DetailOptions {
  /** 超过该字节数的 Body 返回 deferred 占位，减少一次性 IPC 数据量 */
  lazyBodyThreshold?: number
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
  /** 会话内容总内存预算，超出后按最旧优先淘汰 */
  private maxSessionBytes: number
  private totalBytes = 0
  /** 每个条目已计入内存预算的字节数，用于增量更新 */
  private accountedBytes = new Map<string, number>()

  constructor(
    private readonly events: SessionStoreEvents,
    maxEntries = 3000,
    maxSessionBytes = DEFAULT_MAX_SESSION_BYTES
  ) {
    this.maxEntries = maxEntries
    this.maxSessionBytes = maxSessionBytes
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
      decrypted: Boolean(init.decrypted),
      upgrade: Boolean(init.upgrade),
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
      requestCapturedSize: 0,
      responseCapturedSize: 0,
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
      this.account(tx)
      this.events.onAdd(tx.meta)
      this.trim()
    }
    return tx.meta
  }

  touch(tx: StoredTransaction): void {
    if (this.items.has(tx.meta.id)) {
      this.reaccount(tx)
      this.events.onUpdate(tx.meta)
      this.trim()
    }
  }

  finalize(tx: StoredTransaction, state: 'complete' | 'error', error?: string): EntryMeta {
    // 隧道等长连接可能多次触发结束事件，只保留首次结果
    if (tx.timings.totalMs !== undefined) return tx.meta
    const completedAt = Date.now()
    tx.timings.completedAt = completedAt
    tx.timings.totalMs = Math.max(0, completedAt - tx.timings.startedAt)
    // 请求体可能在读取结束时已经合并过；这里只补齐未合并的部分，并及时释放分块内存
    tx.requestBody ??= tx.requestChunks.length ? Buffer.concat(tx.requestChunks) : null
    tx.responseBody ??= tx.responseChunks.length ? Buffer.concat(tx.responseChunks) : null
    tx.requestChunks = []
    tx.responseChunks = []
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
    this.forget(id)
    this.events.onRemove(id)
  }

  clear(): void {
    this.items.clear()
    this.order = []
    this.totalBytes = 0
    this.accountedBytes.clear()
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
    this.enforceLimits(true)
  }

  /**
   * 同时按条目数和总内存预算淘汰最旧记录。
   * 导入会话时传 false，避免逐条触发 onRemove（由主进程整体广播导入结果）。
   */
  private enforceLimits(emitEvents: boolean): void {
    while (this.order.length > this.maxEntries) this.evictOldest(emitEvents)
    // 至少保留最新一条，避免单条超大内容刚捕获就被立即淘汰
    while (this.totalBytes > this.maxSessionBytes && this.order.length > 1) {
      this.evictOldest(emitEvents)
    }
  }

  private evictOldest(emitEvents: boolean): void {
    const id = this.order.shift()
    if (!id) return
    this.items.delete(id)
    this.forget(id)
    if (emitEvents) this.events.onRemove(id)
  }

  /** 条目当前占用的内存估算：头字节 + 实际捕获的 Body 字节 + Body 展示缓存 */
  private bytesOf(tx: StoredTransaction): number {
    return (
      tx.requestHeaderSize +
      tx.responseHeaderSize +
      tx.requestCapturedSize +
      tx.responseCapturedSize +
      this.bodyViewBytes(tx.bodyViewCache?.request) +
      this.bodyViewBytes(tx.bodyViewCache?.response)
    )
  }

  /** BodyView 的内存估算：字符串约为 2 字节/字符，base64 为 ASCII */
  private bodyViewBytes(view?: BodyView): number {
    if (!view) return 0
    return (view.text?.length ?? 0) * 2 + (view.base64?.length ?? 0)
  }

  /** 条目加入会话时计入内存预算 */
  private account(tx: StoredTransaction): void {
    const bytes = this.bytesOf(tx)
    this.accountedBytes.set(tx.meta.id, bytes)
    this.totalBytes += bytes
  }

  /** 条目内容变化后增量更新内存预算 */
  private reaccount(tx: StoredTransaction): void {
    const previous = this.accountedBytes.get(tx.meta.id)
    if (previous === undefined) return
    const next = this.bytesOf(tx)
    this.accountedBytes.set(tx.meta.id, next)
    this.totalBytes += next - previous
  }

  /** 条目移除时从预算中扣除 */
  private forget(id: string): void {
    const bytes = this.accountedBytes.get(id)
    if (bytes === undefined) return
    this.totalBytes = Math.max(0, this.totalBytes - bytes)
    this.accountedBytes.delete(id)
  }

  async toDetail(tx: StoredTransaction, options: DetailOptions = {}): Promise<EntryDetail> {
    // 大 Body 只返回占位，等渲染进程打开对应标签页时再单独拉取
    const requestDeferred = this.shouldDeferBody(tx, 'request', options.lazyBodyThreshold)
    const responseDeferred = this.shouldDeferBody(tx, 'response', options.lazyBodyThreshold)
    const [requestBody, responseBody] = await Promise.all([
      requestDeferred ? Promise.resolve(this.deferredBodyView(tx, 'request')) : this.readBodyView(tx, 'request'),
      responseDeferred ? Promise.resolve(this.deferredBodyView(tx, 'response')) : this.readBodyView(tx, 'response')
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

  /** 按需获取完整 Body，供渲染进程打开 Body 标签页时调用 */
  async getBodyView(id: string, side: 'request' | 'response'): Promise<BodyView | null> {
    const tx = this.items.get(id)
    if (!tx) return null
    return this.readBodyView(tx, side)
  }

  /** 判断某个 Body 是否应该延迟加载；pending 内容仍在变化，不做延迟 */
  private shouldDeferBody(
    tx: StoredTransaction,
    side: 'request' | 'response',
    threshold?: number
  ): boolean {
    if (threshold === undefined || tx.meta.state === 'pending') return false
    const captured = side === 'request' ? tx.requestCapturedSize : tx.responseCapturedSize
    return captured > threshold
  }

  /** 生成延迟加载占位；deferred=true 时渲染进程会通过 getEntryBody 拉取完整内容 */
  private deferredBodyView(tx: StoredTransaction, side: 'request' | 'response'): BodyView {
    const isRequest = side === 'request'
    return {
      available: true,
      size: isRequest ? tx.requestBodySize : tx.responseBodySize,
      capturedSize: isRequest ? tx.requestCapturedSize : tx.responseCapturedSize,
      decodedSize: 0,
      truncated: isRequest ? tx.requestTruncated : tx.responseTruncated,
      textTruncated: false,
      kind: 'empty',
      mime: isRequest ? tx.meta.requestMime : tx.meta.responseMime,
      encoding: isRequest ? tx.requestEncoding : tx.responseEncoding,
      deferred: true
    }
  }

  /** 取单侧 BodyView，并对已完成且体积较小的条目做缓存 */
  private async readBodyView(tx: StoredTransaction, side: 'request' | 'response'): Promise<BodyView> {
    const cacheable =
      tx.meta.state !== 'pending' &&
      tx.requestCapturedSize + tx.responseCapturedSize <= MAX_CACHED_BODY_BYTES
    if (cacheable) {
      const cached = tx.bodyViewCache?.[side]
      if (cached) return cached
      const pending = tx.bodyViewPromises?.[side]
      if (pending) return pending
    }

    const promise = this.renderBodyView(tx, side)
    if (!cacheable) return promise

    tx.bodyViewPromises ??= {}
    tx.bodyViewPromises[side] = promise
      .then((view) => {
        tx.bodyViewCache ??= {}
        tx.bodyViewCache[side] = view
        this.reaccount(tx)
        this.trim()
        return view
      })
      .finally(() => {
        if (tx.bodyViewPromises) tx.bodyViewPromises[side] = undefined
      })
    return tx.bodyViewPromises[side]!
  }

  private async renderBodyView(
    tx: StoredTransaction,
    side: 'request' | 'response'
  ): Promise<BodyView> {
    if (side === 'request') {
      const buffer = tx.requestBody ?? (tx.requestChunks.length ? Buffer.concat(tx.requestChunks) : null)
      return renderBody(buffer, tx.requestBodySize, tx.requestTruncated, tx.meta.requestMime, tx.requestEncoding)
    }
    const buffer = tx.responseBody ?? (tx.responseChunks.length ? Buffer.concat(tx.responseChunks) : null)
    return renderBody(buffer, tx.responseBodySize, tx.responseTruncated, tx.meta.responseMime, tx.responseEncoding)
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
    this.totalBytes = 0
    this.accountedBytes.clear()
    for (const entry of data.entries) {
      if (!entry?.meta?.id || !entry.meta.url) continue
      const meta = { ...entry.meta }
      if (meta.state === 'pending') {
        meta.state = 'complete'
        meta.note = meta.note || '会话恢复时请求尚未完成'
      }
      this.seq = Math.max(this.seq, meta.seq || 0)
      const requestBody = entry.requestBodyBase64 ? Buffer.from(entry.requestBodyBase64, 'base64') : null
      const responseBody = entry.responseBodyBase64 ? Buffer.from(entry.responseBodyBase64, 'base64') : null
      const tx: StoredTransaction = {
        meta,
        requestHeaders: entry.requestHeaders ?? [],
        responseHeaders: entry.responseHeaders ?? [],
        requestHeaderSize: meta.requestSize ? Math.max(0, meta.requestSize - (entry.requestBodySize ?? 0)) : 0,
        responseHeaderSize: meta.responseSize ? Math.max(0, meta.responseSize - (entry.responseBodySize ?? 0)) : 0,
        requestChunks: [],
        responseChunks: [],
        requestBody,
        responseBody,
        requestBodySize: entry.requestBodySize ?? 0,
        responseBodySize: entry.responseBodySize ?? 0,
        requestCapturedSize: requestBody?.length ?? 0,
        responseCapturedSize: responseBody?.length ?? 0,
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
        this.account(tx)
      }
    }
    // 会话导入由主进程整体广播，无需逐条触发事件
    this.enforceLimits(false)
    return this.list()
  }
}
