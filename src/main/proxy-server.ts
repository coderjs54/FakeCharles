import http from 'node:http'
import net from 'node:net'
import { performance } from 'node:perf_hooks'
import os from 'node:os'
import type { Duplex } from 'node:stream'
import type { ComposePayload, EntryMeta, HeaderPair, ProxyStatus } from '../shared/types'
import type { SessionStore, StoredTransaction } from './session-store'

export interface ProxyOptions {
  port: number
  allowLan: boolean
  maxBodySize: number
  recordTunnels: boolean
  recording: boolean
}

export interface ProxyHooks {
  onStatus: (status: ProxyStatus) => void
  onError: (message: string) => void
  /** 代理成功启动/停止后触发，用于同步系统代理等外部状态 */
  onLifecycle?: () => void
}

/** 这些头只对单跳连接有效，转发时需要剥离 */
const HOP_BY_HOP = new Set([
  'proxy-connection',
  'proxy-authorization',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'transfer-encoding'
])

const REQUEST_TIMEOUT_MS = 5 * 60_000

interface DispatchParams {
  tx: StoredTransaction | null
  method: string
  target: URL
  headers: http.OutgoingHttpHeaders
  incoming?: http.IncomingMessage
  body?: Buffer | null
  clientRes?: http.ServerResponse
  perfStart: number
}

/**
 * HTTP 抓包代理。
 * - 支持标准 HTTP 代理请求（absolute-form URL）
 * - HTTPS 通过 CONNECT 隧道透传，只记录一条提示条目，不做解密
 * - 请求/响应体按配置上限截断捕获，供详情面板查看
 */
export class CaptureProxy {
  private server: http.Server | null = null
  private options: ProxyOptions
  private status: ProxyStatus
  private sockets = new Set<Duplex>()

  constructor(
    private readonly store: SessionStore,
    private readonly hooks: ProxyHooks,
    options: ProxyOptions
  ) {
    this.options = { ...options }
    this.status = {
      running: false,
      host: '127.0.0.1',
      port: options.port,
      recording: options.recording,
      startedAt: undefined
    }
  }

  getStatus(): ProxyStatus {
    return { ...this.status }
  }

  updateOptions(patch: Partial<ProxyOptions>): void {
    this.options = { ...this.options, ...patch }
    if (this.status.port !== this.options.port || this.status.recording !== this.options.recording) {
      this.status = { ...this.status, port: this.options.port, recording: this.options.recording }
      this.hooks.onStatus(this.getStatus())
    }
  }

  setRecording(recording: boolean): ProxyStatus {
    this.options.recording = recording
    this.status = { ...this.status, recording }
    this.hooks.onStatus(this.getStatus())
    return this.getStatus()
  }

  async start(portOverride?: number): Promise<ProxyStatus> {
    if (typeof portOverride === 'number' && Number.isFinite(portOverride)) this.options.port = portOverride
    await this.stop(true)

    const server = http.createServer((req, res) => this.onRequest(req, res))
    server.on('connect', (req, socket, head) => this.onConnect(req, socket, head))
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head))
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    })

    const bindHost = this.options.allowLan ? '0.0.0.0' : '127.0.0.1'
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error)
        server.once('error', onError)
        server.listen(this.options.port, bindHost, () => {
          server.off('error', onError)
          resolve()
        })
      })
    } catch (error) {
      const message = describeListenError(error as NodeJS.ErrnoException, this.options.port)
      this.status = {
        running: false,
        host: bindHost === '0.0.0.0' ? this.lanAddress() : '127.0.0.1',
        port: this.options.port,
        recording: this.options.recording,
        error: message
      }
      this.hooks.onStatus(this.getStatus())
      this.hooks.onError(message)
      this.hooks.onLifecycle?.()
      throw new Error(message)
    }

    this.server = server
    server.on('error', (error) => {
      const message = describeListenError(error as NodeJS.ErrnoException, this.options.port)
      this.status = { ...this.status, running: false, error: message }
      this.hooks.onStatus(this.getStatus())
      this.hooks.onError(message)
    })

    this.status = {
      running: true,
      host: bindHost === '0.0.0.0' ? this.lanAddress() : '127.0.0.1',
      port: this.options.port,
      recording: this.options.recording,
      startedAt: Date.now()
    }
    this.hooks.onStatus(this.getStatus())
    this.hooks.onLifecycle?.()
    return this.getStatus()
  }

  async stop(silent = false): Promise<void> {
    const server = this.server
    this.server = null
    this.store.failPending('代理已停止，请求未完成')
    if (server) {
      server.close()
      server.closeAllConnections()
    }
    for (const socket of this.sockets) {
      try {
        socket.destroy()
      } catch {
        // ignore
      }
    }
    this.sockets.clear()
    this.status = { ...this.status, running: false, startedAt: undefined }
    if (!silent) {
      this.hooks.onStatus(this.getStatus())
      this.hooks.onLifecycle?.()
    }
  }

  /** 重放指定请求（仅 HTTP） */
  resend(id: string): EntryMeta {
    const source = this.store.get(id)
    if (!source) throw new Error('原请求已不存在')
    if (source.meta.state === 'pending') throw new Error('请求尚未完成，暂时无法重放')
    if (source.meta.protocol !== 'http' || source.meta.method === 'CONNECT') {
      throw new Error('HTTPS 隧道请求无法重放，FakeCharles 仅支持 HTTP')
    }
    const target = new URL(source.meta.url)
    const headers = buildOutgoingHeaders(source.requestHeaders, target)
    const body = source.requestBody ?? (source.requestChunks.length ? Buffer.concat(source.requestChunks) : null)
    const tx = this.store.create({
      method: source.meta.method,
      url: source.meta.url,
      host: source.meta.host,
      port: source.meta.port,
      path: source.meta.path,
      protocol: 'http',
      clientIp: '127.0.0.1',
      note: source.requestTruncated ? '重放请求（原请求体已被截断）' : '重放请求',
      repeatOf: source.meta.id,
      httpVersion: 'HTTP/1.1'
    })
    tx.requestHeaders = source.requestHeaders.map((pair) => [...pair] as HeaderPair)
    tx.requestHeaderSize = source.requestHeaderSize
    tx.requestEncoding = source.requestEncoding
    tx.meta.requestMime = source.meta.requestMime
    tx.requestBodySize = body?.length ?? 0
    tx.meta.requestSize = tx.requestHeaderSize + tx.requestBodySize
    if (body) {
      const limit = this.options.maxBodySize
      tx.requestChunks.push(body.length > limit ? body.subarray(0, limit) : body)
      if (body.length > limit) tx.requestTruncated = true
    }
    this.store.commit(tx)

    const perfStart = performance.now()
    this.dispatch({
      tx,
      method: source.meta.method,
      target,
      headers,
      body,
      perfStart
    })
    return tx.meta
  }

  /** 手动构造并发送请求 */
  compose(payload: ComposePayload): EntryMeta {
    const rawUrl = payload.url.trim()
    if (!rawUrl) throw new Error('请填写请求 URL')
    const withProtocol = /^[a-z]+:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`
    let target: URL
    try {
      target = new URL(withProtocol)
    } catch {
      throw new Error('URL 格式不正确')
    }
    if (target.protocol !== 'http:') throw new Error('FakeCharles 仅支持发送 HTTP 请求（不支持 HTTPS）')
    const method = (payload.method || 'GET').toUpperCase()
    const headerPairs = parseHeaderText(payload.headers)
    const bodyBuffer = payload.body ? Buffer.from(payload.body, 'utf8') : null
    const headers = buildOutgoingHeaders(headerPairs, target)
    if (bodyBuffer && headers['content-length'] === undefined) {
      headers['content-length'] = String(bodyBuffer.length)
    }
    if (!hasHeader(headerPairs, 'user-agent')) headers['user-agent'] = 'FakeCharles/1.0'

    const tx = this.store.create({
      method,
      url: target.toString(),
      host: target.hostname,
      port: Number(target.port || 80),
      path: `${target.pathname}${target.search}`,
      protocol: 'http',
      clientIp: '127.0.0.1',
      note: 'Compose 手动发送',
      httpVersion: 'HTTP/1.1'
    })
    tx.requestHeaders = pairsFromOutgoingHeaders(headers, target)
    tx.requestHeaderSize = headerPairsSize(tx.requestHeaders) + requestLineSize(method, `${target.pathname}${target.search}`)
    tx.meta.requestMime = String(headers['content-type'] ?? '')
    tx.requestBodySize = bodyBuffer?.length ?? 0
    tx.meta.requestSize = tx.requestHeaderSize + tx.requestBodySize
    if (bodyBuffer) {
      const limit = this.options.maxBodySize
      tx.requestChunks.push(bodyBuffer.length > limit ? bodyBuffer.subarray(0, limit) : bodyBuffer)
      if (bodyBuffer.length > limit) tx.requestTruncated = true
    }
    this.store.commit(tx)

    this.dispatch({
      tx,
      method,
      target,
      headers,
      body: bodyBuffer,
      perfStart: performance.now()
    })
    return tx.meta
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const perfStart = performance.now()
    // 浏览器直接访问代理端口时是 origin-form 请求，返回使用说明而不是把请求转发给自身
    if (!/^[a-z]+:\/\//i.test(req.url ?? '') && this.isSelfRequest(req)) {
      this.sendMessage(
        res,
        200,
        'FakeCharles HTTP 代理已运行',
        '当前访问的是代理端口本身。请在浏览器或系统中配置 HTTP 代理后访问目标站点。'
      )
      return
    }

    let target: URL
    try {
      target = resolveTarget(req)
    } catch {
      this.sendMessage(res, 400, 'Bad Request', '无法解析请求地址，请确认已将浏览器/系统 HTTP 代理指向 FakeCharles。')
      return
    }
    if (target.protocol !== 'http:') {
      this.sendMessage(res, 501, 'Not Implemented', 'FakeCharles 只抓取 HTTP 请求。HTTPS 会以 CONNECT 隧道形式透传，不进行解密。')
      return
    }

    const clientIp = normalizeIp(req.socket.remoteAddress)
    const tx = this.options.recording ? this.buildTransaction(req, target, clientIp) : null
    const headers = forwardHeaders(req, target)

    this.dispatch({
      tx,
      method: req.method || 'GET',
      target,
      headers,
      incoming: req,
      clientRes: res,
      perfStart
    })
  }

  private buildTransaction(req: http.IncomingMessage, target: URL, clientIp: string): StoredTransaction {
    const tx = this.store.create({
      method: req.method || 'GET',
      url: target.toString(),
      host: target.hostname,
      port: Number(target.port || 80),
      path: `${target.pathname}${target.search}`,
      protocol: 'http',
      clientIp,
      httpVersion: `HTTP/${req.httpVersion}`
    })
    tx.requestHeaders = collectHeaders(req.rawHeaders)
    tx.requestHeaderSize = rawHeadersSize(req.rawHeaders) + requestLineSize(req.method || 'GET', req.url || '/')
    tx.requestEncoding = headerValue(req.rawHeaders, 'content-encoding') || undefined
    tx.meta.requestMime = headerValue(req.rawHeaders, 'content-type')
    tx.meta.requestSize = tx.requestHeaderSize
    this.store.commit(tx)
    return tx
  }

  /**
   * 统一的请求转发 & 抓包流程。
   * 代理请求会把上游响应实时 pipe 回客户端；Compose / Repeat 则不传 clientRes，只消费并记录响应。
   */
  private dispatch(params: DispatchParams): void {
    const { tx, target, method, headers, incoming, body, clientRes, perfStart } = params
    const captureLimit = this.options.maxBodySize
    let requestCaptured = 0
    let responseCaptured = 0
    let finalized = false
    let responseStarted = false

    const finish = (state: 'complete' | 'error', error?: string): void => {
      if (finalized) return
      finalized = true
      if (tx) this.store.finalize(tx, state, error)
      if (state === 'error' && clientRes && !clientRes.writableEnded) {
        clientRes.destroy()
      }
    }

    const upstream = http.request({
      protocol: 'http:',
      hostname: target.hostname,
      port: Number(target.port || 80),
      method,
      path: `${target.pathname || '/'}${target.search}`,
      headers,
      agent: false
    })
    upstream.setTimeout(REQUEST_TIMEOUT_MS)
    upstream.on('timeout', () => upstream.destroy(new Error('请求超时（5 分钟）')))

    upstream.on('response', (upstreamRes) => {
      responseStarted = true
      const responseHeaders = collectHeaders(upstreamRes.rawHeaders)
      const responseHeaderSize = rawHeadersSize(upstreamRes.rawHeaders) + statusLineSize(upstreamRes)

      if (tx) {
        tx.meta.status = upstreamRes.statusCode
        tx.meta.statusText = upstreamRes.statusMessage || ''
        tx.meta.responseMime = headerValue(upstreamRes.rawHeaders, 'content-type')
        tx.responseEncoding = headerValue(upstreamRes.rawHeaders, 'content-encoding') || undefined
        tx.responseHeaders = responseHeaders
        tx.responseHeaderSize = responseHeaderSize
        tx.responseBodySize = 0
        tx.meta.responseSize = responseHeaderSize
        tx.httpVersion = `HTTP/${upstreamRes.httpVersion}`
        tx.timings.firstByteAt = Date.now()
        tx.timings.waitMs = Math.max(0, Math.round(performance.now() - perfStart))
        this.store.touch(tx)
      }

      if (clientRes) {
        const raw = filterRawHeaders(upstreamRes.rawHeaders, RESPONSE_DROP_HEADERS)
        try {
          clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, raw)
        } catch {
          clientRes.writeHead(upstreamRes.statusCode ?? 502, raw)
        }
        clientRes.on('error', () => upstreamRes.destroy())
        upstreamRes.on('error', () => {
          if (!clientRes.writableEnded) clientRes.destroy()
        })
        upstreamRes.pipe(clientRes)
      }

      upstreamRes.on('data', (chunk: Buffer) => {
        if (!tx) return
        tx.responseBodySize += chunk.length
        const room = captureLimit - responseCaptured
        if (room > 0) {
          const slice = chunk.length <= room ? chunk : chunk.subarray(0, room)
          tx.responseChunks.push(slice)
          responseCaptured += slice.length
        }
        if (chunk.length > room) tx.responseTruncated = true
        tx.meta.responseSize = tx.responseHeaderSize + tx.responseBodySize
      })
      upstreamRes.on('end', () => {
        if (tx) {
          const endedAt = Date.now()
          tx.timings.receiveMs = Math.max(0, endedAt - (tx.timings.firstByteAt || endedAt))
        }
        finish('complete')
      })
      upstreamRes.on('aborted', () => finish('error', '响应传输被中断'))
      upstreamRes.on('error', (error) => finish('error', friendlyError(error)))
    })

    upstream.on('error', (error) => {
      const message = friendlyError(error)
      if (clientRes && !responseStarted && !clientRes.headersSent) {
        this.sendMessage(clientRes, 502, 'Bad Gateway', message)
      }
      finish('error', message)
    })

    if (clientRes) {
      clientRes.on('close', () => {
        if (!finalized && !clientRes.writableEnded) {
          upstream.destroy()
          finish('error', '客户端提前断开连接')
        }
      })
    }

    if (incoming) {
      incoming.on('data', (chunk: Buffer) => {
        if (tx) {
          tx.requestBodySize += chunk.length
          const room = captureLimit - requestCaptured
          if (room > 0) {
            const slice = chunk.length <= room ? chunk : chunk.subarray(0, room)
            tx.requestChunks.push(slice)
            requestCaptured += slice.length
          }
          if (chunk.length > room) tx.requestTruncated = true
          tx.meta.requestSize = tx.requestHeaderSize + tx.requestBodySize
        }
        if (!upstream.destroyed && !upstream.write(chunk)) {
          incoming.pause()
          upstream.once('drain', () => incoming.resume())
        }
      })
      incoming.on('end', () => {
        if (tx) {
          tx.requestBody = tx.requestChunks.length ? Buffer.concat(tx.requestChunks) : null
          tx.meta.requestSize = tx.requestHeaderSize + tx.requestBodySize
          this.store.touch(tx)
        }
        if (!upstream.destroyed) upstream.end()
      })
      incoming.on('error', (error) => upstream.destroy(error))
      incoming.on('close', () => {
        if (!incoming.complete && !upstream.destroyed) {
          upstream.destroy(new Error('客户端提前断开连接'))
        }
      })
    } else {
      if (body && body.length) upstream.end(body)
      else upstream.end()
    }
  }

  private onConnect(req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    const target = splitHostPort(req.url || '')
    if (!target) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }

    const tx =
      this.options.recording && this.options.recordTunnels
        ? this.buildTunnelTransaction(req, target.host, target.port)
        : null

    let settled = false
    const upstream = net.connect(target.port, target.host, () => {
      if (settled) return
      settled = true
      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: FakeCharles\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
      if (tx) {
        tx.meta.status = 200
        tx.meta.statusText = 'Connection Established'
        tx.responseHeaders = [['proxy-agent', 'FakeCharles']]
        tx.responseHeaderSize = 0
        tx.meta.responseSize = 0
        this.store.finalize(tx, 'complete')
      }
    })

    clientSocket.on('error', () => upstream.destroy())
    clientSocket.on('close', () => upstream.destroy())
    upstream.on('error', (error) => {
      if (!settled) {
        settled = true
        const message = friendlyError(error)
        if (!clientSocket.destroyed) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        if (tx) this.store.finalize(tx, 'error', message)
        this.hooks.onError(`HTTPS 隧道建立失败：${message}`)
      } else if (tx) {
        this.store.finalize(tx, 'complete')
      }
    })
    upstream.on('close', () => {
      if (tx) this.store.finalize(tx, 'complete')
      if (!clientSocket.destroyed) clientSocket.destroy()
    })
  }

  private onUpgrade(req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    const rawUrl = req.url || '/'
    let target: URL
    try {
      target = /^[a-z]+:\/\//i.test(rawUrl)
        ? new URL(rawUrl)
        : new URL(`http://${req.headers.host ?? '127.0.0.1'}${rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`}`)
    } catch {
      clientSocket.destroy()
      return
    }
    const tx = this.options.recording
      ? this.store.create({
          method: req.method || 'GET',
          url: target.toString(),
          host: target.hostname,
          port: Number(target.port || 80),
          path: `${target.pathname}${target.search}`,
          protocol: 'http',
          clientIp: normalizeIp(req.socket.remoteAddress),
          note: 'WebSocket / Upgrade 连接（仅透传，不解析内容）'
        })
      : null
    if (tx) {
      tx.requestHeaders = collectHeaders(req.rawHeaders)
      tx.requestHeaderSize = rawHeadersSize(req.rawHeaders) + requestLineSize(req.method || 'GET', rawUrl)
      tx.meta.requestSize = tx.requestHeaderSize
      this.store.commit(tx)
    }

    const upstream = net.connect(Number(target.port || 80), target.hostname, () => {
      upstream.write(`${req.method} ${target.pathname}${target.search} HTTP/1.1\r\n`)
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        upstream.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`)
      }
      upstream.write('\r\n')
      if (head?.length) upstream.write(head)
      if (tx) {
        tx.meta.status = 101
        tx.meta.statusText = 'Switching Protocols'
        this.store.finalize(tx, 'complete')
      }
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    clientSocket.on('error', () => upstream.destroy())
    clientSocket.on('close', () => upstream.destroy())
    upstream.on('error', (error) => {
      if (tx) this.store.finalize(tx, 'error', friendlyError(error))
      if (!clientSocket.destroyed) clientSocket.destroy()
    })
    upstream.on('close', () => {
      if (tx) this.store.finalize(tx, 'complete')
      if (!clientSocket.destroyed) clientSocket.destroy()
    })
  }

  private buildTunnelTransaction(req: http.IncomingMessage, host: string, port: number): StoredTransaction {
    const urlHost = host.includes(':') ? `[${host}]` : host
    const tx = this.store.create({
      method: 'CONNECT',
      url: `https://${urlHost}:${port}`,
      host,
      port,
      path: '/',
      protocol: 'https',
      clientIp: normalizeIp(req.socket.remoteAddress),
      tunnel: true,
      note: 'HTTPS 流量通过 CONNECT 隧道透传，内容未解密。FakeCharles 当前仅支持抓取 HTTP 明文请求。'
    })
    tx.requestHeaders = collectHeaders(req.rawHeaders)
    tx.requestHeaderSize = rawHeadersSize(req.rawHeaders)
    tx.meta.requestSize = tx.requestHeaderSize
    this.store.commit(tx)
    return tx
  }

  private sendMessage(res: http.ServerResponse, status: number, title: string, message: string): void {
    if (res.headersSent) {
      res.end()
      return
    }
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)} · FakeCharles</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f6f9;font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#1f2937}
.card{background:#fff;border:1px solid #e5e8ee;border-radius:12px;padding:32px 36px;max-width:560px;box-shadow:0 12px 32px rgba(15,23,42,.08)}
h1{margin:0 0 8px;font-size:18px}code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-family:Consolas,monospace}
p{line-height:1.7;font-size:13px;color:#4b5563}</style></head><body>
<div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
<p>这是 <strong>FakeCharles</strong> 的 HTTP 代理端口。请把浏览器或系统的 <strong>HTTP 代理</strong> 指向当前地址后访问页面。</p></div></body></html>`
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(html)
    })
    res.end(html)
  }

  private lanAddress(): string {
    const interfaces = os.networkInterfaces()
    for (const entries of Object.values(interfaces)) {
      for (const entry of entries ?? []) {
        if (entry.family === 'IPv4' && !entry.internal) return entry.address
      }
    }
    return '0.0.0.0'
  }

  /** 判断 origin-form 请求是否是在直接访问代理自身，避免代理把请求转发给自己造成死循环 */
  private isSelfRequest(req: http.IncomingMessage): boolean {
    const header = String(req.headers.host ?? '').toLowerCase()
    const target = splitHostPort(header)
    if (!target || target.port !== this.options.port) return false
    const localNames = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0'])
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries ?? []) {
        localNames.add(entry.address.toLowerCase())
      }
    }
    return localNames.has(target.host.toLowerCase())
  }
}

function resolveTarget(req: http.IncomingMessage): URL {
  const raw = req.url || '/'
  if (/^[a-z]+:\/\//i.test(raw)) return new URL(raw)
  const host = req.headers.host
  if (!host) throw new Error('缺少 Host 请求头')
  return new URL(`http://${host}${raw.startsWith('/') ? raw : `/${raw}`}`)
}

function forwardHeaders(req: http.IncomingMessage, target: URL): http.OutgoingHttpHeaders {
  return buildOutgoingHeaders(collectHeaders(req.rawHeaders), target)
}

function buildOutgoingHeaders(pairs: HeaderPair[], target: URL): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {}
  for (const [rawName, rawValue] of pairs) {
    const name = rawName.toLowerCase()
    if (HOP_BY_HOP.has(name) || name === 'host' || name === 'expect') continue
    const current = headers[name]
    if (current === undefined) headers[name] = rawValue
    else if (Array.isArray(current)) current.push(rawValue)
    else headers[name] = [String(current), rawValue]
  }
  headers.host = target.host
  return headers
}

function pairsFromOutgoingHeaders(headers: http.OutgoingHttpHeaders, target: URL): HeaderPair[] {
  const pairs: HeaderPair[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) pairs.push([name, String(item)])
    } else {
      pairs.push([name, String(value)])
    }
  }
  if (!pairs.some(([name]) => name.toLowerCase() === 'host')) pairs.push(['host', target.host])
  return pairs
}

function parseHeaderText(text: string): HeaderPair[] {
  const pairs: HeaderPair[] = []
  for (const rawLine of (text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf(':')
    if (index <= 0) continue
    pairs.push([line.slice(0, index).trim(), line.slice(index + 1).trim()])
  }
  return pairs
}

function hasHeader(pairs: HeaderPair[], name: string): boolean {
  return pairs.some(([key]) => key.toLowerCase() === name)
}

function collectHeaders(raw: string[]): HeaderPair[] {
  const pairs: HeaderPair[] = []
  for (let i = 0; i < raw.length - 1; i += 2) pairs.push([raw[i], raw[i + 1]])
  return pairs
}

function headerValue(raw: string[], name: string): string {
  const lower = name.toLowerCase()
  for (let i = 0; i < raw.length - 1; i += 2) {
    if (raw[i].toLowerCase() === lower) return raw[i + 1]
  }
  return ''
}

function rawHeadersSize(raw: string[]): number {
  let size = 2
  for (let i = 0; i < raw.length - 1; i += 2) size += raw[i].length + raw[i + 1].length + 4
  return size
}

function headerPairsSize(pairs: HeaderPair[]): number {
  let size = 2
  for (const [name, value] of pairs) size += name.length + value.length + 4
  return size
}

function requestLineSize(method: string, url: string): number {
  return method.length + url.length + 'HTTP/1.1'.length + 4
}

function statusLineSize(res: http.IncomingMessage): number {
  return (res.statusCode?.toString().length ?? 3) + (res.statusMessage?.length ?? 0) + 13
}

const RESPONSE_DROP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'trailer'])

function filterRawHeaders(raw: string[], drop: Set<string>): string[] {
  const result: string[] = []
  for (let i = 0; i < raw.length - 1; i += 2) {
    if (!drop.has(raw[i].toLowerCase())) result.push(raw[i], raw[i + 1])
  }
  return result
}

function normalizeIp(address?: string): string {
  if (!address) return '-'
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

function splitHostPort(value: string): { host: string; port: number } | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end < 0) return null
    const host = trimmed.slice(1, end)
    const rest = trimmed.slice(end + 1)
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : 443
    return host && Number.isFinite(port) ? { host, port } : null
  }
  const lastColon = trimmed.lastIndexOf(':')
  if (lastColon === -1) return { host: trimmed, port: 443 }
  const host = trimmed.slice(0, lastColon)
  const port = Number(trimmed.slice(lastColon + 1))
  if (!host || !Number.isFinite(port)) return null
  return { host, port }
}

function friendlyError(error: NodeJS.ErrnoException): string {
  const code = error.code ?? ''
  if (code === 'ECONNREFUSED') return '连接被拒绝：目标服务器未监听该端口'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败，无法找到目标服务器'
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return '连接目标服务器超时'
  if (code === 'ECONNRESET' || code === 'EPIPE') return '连接被目标服务器重置'
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return '目标主机不可达'
  return error.message || '请求失败'
}

function describeListenError(error: NodeJS.ErrnoException, port: number): string {
  if (error.code === 'EADDRINUSE') {
    return `端口 ${port} 已被占用（可能正在运行 Charles 或其他代理工具），请关闭占用程序或在设置中更换端口`
  }
  if (error.code === 'EACCES') return `没有权限监听端口 ${port}，请更换为 1024 以上的端口`
  return `代理启动失败：${error.message}`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}
