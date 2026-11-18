import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { performance } from 'node:perf_hooks'
import os from 'node:os'
import type { Duplex } from 'node:stream'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import type { ComposePayload, EntryMeta, HeaderPair, HttpsCaInfo, ProxyStatus } from '../shared/types'
import { parseUpstreamProxyUrl, type UpstreamProxyConfig } from '../shared/upstream-proxy'
import type { CertificateAuthority } from './cert-manager'
import type { SessionStore, StoredTransaction } from './session-store'

export interface ProxyOptions {
  port: number
  allowLan: boolean
  maxBodySize: number
  recordTunnels: boolean
  recording: boolean
  /** 是否对 HTTPS CONNECT 连接做 TLS 中间人解密 */
  decryptHttps: boolean
  /** 是否忽略代理到上游服务器的 TLS 证书错误 */
  allowInsecureUpstream: boolean
  /** 上游 HTTP 代理地址；为空表示直连 */
  upstreamProxyUrl?: string
  /** 仅测试使用：额外信任的上游 CA PEM */
  upstreamCa?: string
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
  secure?: boolean
}

/**
 * HTTP 抓包代理。
 * - 支持标准 HTTP 代理请求（absolute-form URL）
 * - HTTPS 默认通过 CONNECT 隧道透传；开启 HTTPS 解密后使用本地 CA 做 TLS 中间人
 * - 请求/响应体按配置上限截断捕获，供详情面板查看
 */
export class CaptureProxy {
  private server: http.Server | null = null
  private options: ProxyOptions
  private status: ProxyStatus
  private sockets = new Set<Duplex>()
  private readonly mitmHttpServer: http.Server
  private readonly mitmTargets = new WeakMap<net.Socket, { host: string; port: number }>()
  /** 上游代理连接器；为空表示直连目标服务器 */
  private upstreamHttpAgent: HttpProxyAgent<string> | null = null
  private upstreamHttpsAgent: HttpsProxyAgent<string> | null = null
  private upstreamProxy: UpstreamProxyConfig | undefined

  constructor(
    private readonly store: SessionStore,
    private readonly hooks: ProxyHooks,
    options: ProxyOptions,
    private readonly ca?: CertificateAuthority
  ) {
    this.options = { ...options }
    this.configureUpstreamProxy()
    this.status = {
      running: false,
      host: '127.0.0.1',
      port: options.port,
      recording: options.recording,
      startedAt: undefined
    }

    this.mitmHttpServer = http.createServer((req, res) => this.onDecryptedRequest(req, res))
    this.mitmHttpServer.on('upgrade', (req, socket, head) => this.onDecryptedUpgrade(req, socket, head))
    this.mitmHttpServer.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    })
  }

  getStatus(): ProxyStatus {
    return { ...this.status }
  }

  getHttpsCaInfo(): HttpsCaInfo {
    if (!this.ca) {
      return {
        supported: false,
        installable: false,
        generated: false,
        platform: process.platform,
        error: '当前环境未初始化 HTTPS 证书管理器'
      }
    }
    return this.ca.getInfo()
  }

  ensureHttpsCa(): HttpsCaInfo {
    if (!this.ca) return this.getHttpsCaInfo()
    return this.ca.ensure()
  }

  installHttpsCa(): HttpsCaInfo {
    if (!this.ca) return this.getHttpsCaInfo()
    return this.ca.install()
  }

  getHttpsCaPem(): string {
    return this.ca?.getCaPem() ?? ''
  }

  updateOptions(patch: Partial<ProxyOptions>): void {
    const previous = this.options
    this.options = { ...this.options, ...patch }
    if (
      (patch.upstreamProxyUrl !== undefined && patch.upstreamProxyUrl !== previous.upstreamProxyUrl) ||
      (patch.allowInsecureUpstream !== undefined &&
        patch.allowInsecureUpstream !== previous.allowInsecureUpstream)
    ) {
      this.configureUpstreamProxy()
    }
    // 运行中时实际监听端口不会立即改变，需等 stop/start 后再同步，避免状态栏显示错误端口
    const portChanged = !this.status.running && this.status.port !== this.options.port
    if (portChanged || this.status.recording !== this.options.recording) {
      this.status = { ...this.status, port: this.options.port, recording: this.options.recording }
      this.hooks.onStatus(this.getStatus())
    }
  }

  /** 重新构建上游代理连接器；空地址表示直连目标服务器 */
  private configureUpstreamProxy(): void {
    this.upstreamHttpAgent?.destroy()
    this.upstreamHttpsAgent?.destroy()
    this.upstreamHttpAgent = null
    this.upstreamHttpsAgent = null
    this.upstreamProxy = undefined

    const raw = this.options.upstreamProxyUrl?.trim() ?? ''
    if (!raw) return

    const result = parseUpstreamProxyUrl(raw)
    if (!result.config) {
      this.hooks.onError(`上游代理配置无效：${result.error}`)
      return
    }
    this.upstreamProxy = result.config
    try {
      this.upstreamHttpAgent = new HttpProxyAgent(result.config.url)
      this.upstreamHttpsAgent = new HttpsProxyAgent(result.config.url, {
        rejectUnauthorized: !this.options.allowInsecureUpstream
      })
    } catch (error) {
      this.upstreamProxy = undefined
      this.hooks.onError(`上游代理初始化失败：${friendlyError(error as NodeJS.ErrnoException)}`)
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
    // stop 会释放上游代理连接，重新启动时按当前配置重建
    this.configureUpstreamProxy()

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
      throw new Error(message, { cause: error })
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
    // 释放上游代理连接，避免停止后仍持有 socket
    this.upstreamHttpAgent?.destroy()
    this.upstreamHttpsAgent?.destroy()
    this.upstreamHttpAgent = null
    this.upstreamHttpsAgent = null
    this.upstreamProxy = undefined
    this.status = { ...this.status, running: false, startedAt: undefined }
    if (!silent) {
      this.hooks.onStatus(this.getStatus())
      this.hooks.onLifecycle?.()
    }
  }

  /** 重放指定请求；HTTPS 需要是已解密条目，原始 CONNECT 隧道不可重放 */
  resend(id: string): EntryMeta {
    const source = this.store.get(id)
    if (!source) throw new Error('原请求已不存在')
    if (source.meta.state === 'pending') throw new Error('请求尚未完成，暂时无法重放')
    if (source.meta.upgrade) throw new Error('WebSocket / Upgrade 请求无法重放')
    if (source.meta.tunnel || source.meta.method === 'CONNECT') {
      throw new Error('HTTPS 隧道请求无法重放，请先开启 HTTPS 解密并选择解密后的请求')
    }
    const target = new URL(source.meta.url)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error('当前请求协议不支持重放')
    }
    const isHttps = target.protocol === 'https:'
    const headers = buildOutgoingHeaders(source.requestHeaders, target)
    const body = source.requestBody ?? (source.requestChunks.length ? Buffer.concat(source.requestChunks) : null)
    const tx = this.store.create({
      method: source.meta.method,
      url: source.meta.url,
      host: source.meta.host,
      port: source.meta.port,
      path: source.meta.path,
      protocol: isHttps ? 'https' : 'http',
      clientIp: '127.0.0.1',
      decrypted: isHttps,
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
      const slice = body.length > limit ? body.subarray(0, limit) : body
      tx.requestChunks.push(slice)
      tx.requestCapturedSize += slice.length
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
      perfStart,
      secure: isHttps
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
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error('仅支持 http / https 请求')
    }
    const isHttps = target.protocol === 'https:'
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
      host: bareHostname(target.hostname),
      port: Number(target.port || (isHttps ? 443 : 80)),
      path: `${target.pathname}${target.search}`,
      protocol: isHttps ? 'https' : 'http',
      clientIp: '127.0.0.1',
      decrypted: isHttps,
      note: isHttps ? 'Compose 手动发送（HTTPS）' : 'Compose 手动发送',
      httpVersion: 'HTTP/1.1'
    })
    tx.requestHeaders = pairsFromOutgoingHeaders(headers, target)
    tx.requestHeaderSize = headerPairsSize(tx.requestHeaders) + requestLineSize(method, `${target.pathname}${target.search}`)
    tx.meta.requestMime = String(headers['content-type'] ?? '')
    tx.requestBodySize = bodyBuffer?.length ?? 0
    tx.meta.requestSize = tx.requestHeaderSize + tx.requestBodySize
    if (bodyBuffer) {
      const limit = this.options.maxBodySize
      const slice = bodyBuffer.length > limit ? bodyBuffer.subarray(0, limit) : bodyBuffer
      tx.requestChunks.push(slice)
      tx.requestCapturedSize += slice.length
      if (bodyBuffer.length > limit) tx.requestTruncated = true
    }
    this.store.commit(tx)

    this.dispatch({
      tx,
      method,
      target,
      headers,
      body: bodyBuffer,
      perfStart: performance.now(),
      secure: isHttps
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
    const isHttps = target.protocol === 'https:'
    const tx = this.store.create({
      method: req.method || 'GET',
      url: target.toString(),
      host: bareHostname(target.hostname),
      port: Number(target.port || (isHttps ? 443 : 80)),
      path: `${target.pathname}${target.search}`,
      protocol: isHttps ? 'https' : 'http',
      clientIp,
      decrypted: isHttps,
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
    const { tx, target, method, headers, incoming, body, clientRes, perfStart, secure = false } = params
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

    const upstreamHost = bareHostname(target.hostname)
    let upstream: http.ClientRequest
    try {
      upstream = secure
        ? https.request({
            protocol: 'https:',
            hostname: upstreamHost,
            port: Number(target.port || 443),
            method,
            path: `${target.pathname || '/'}${target.search}`,
            headers,
            // 配置了上游代理时由 HttpsProxyAgent 建立 CONNECT 隧道
            agent: this.upstreamHttpsAgent ?? false,
            rejectUnauthorized: !this.options.allowInsecureUpstream,
            servername: net.isIP(upstreamHost) ? undefined : upstreamHost,
            ...(this.options.upstreamCa ? { ca: this.options.upstreamCa } : {})
          })
        : http.request({
            protocol: 'http:',
            hostname: upstreamHost,
            port: Number(target.port || 80),
            method,
            path: `${target.pathname || '/'}${target.search}`,
            headers,
            // 配置了上游代理时由 HttpProxyAgent 改写为绝对形式请求
            agent: this.upstreamHttpAgent ?? false
          })
    } catch (error) {
      // http.request 会在 Header 非法等情况下同步抛错；这里兜底，避免留下 pending 条目或抛出到全局
      const message = friendlyError(error as NodeJS.ErrnoException)
      if (clientRes && !clientRes.headersSent) {
        this.sendMessage(clientRes, 502, 'Bad Gateway', message)
      }
      finish('error', message)
      return
    }
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
          try {
            clientRes.writeHead(upstreamRes.statusCode ?? 502, raw)
          } catch {
            // 上游响应头包含无法转发的内容时回退到错误页，避免在事件回调里抛出未捕获异常
            const message = '上游响应头包含无法转发的内容'
            if (!clientRes.headersSent) this.sendMessage(clientRes, 502, 'Bad Gateway', message)
            upstreamRes.destroy()
            finish('error', message)
            return
          }
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
          tx.responseCapturedSize += slice.length
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
            tx.requestCapturedSize += slice.length
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
          // 请求体读取完成后立即合并并释放分块，避免与 finalize 阶段重复持有内存
          tx.requestBody = tx.requestChunks.length ? Buffer.concat(tx.requestChunks) : null
          tx.requestChunks = []
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

    if (this.options.decryptHttps && this.ca) {
      if (this.startMitm(req, clientSocket, head, target)) return
    }

    const tx =
      this.options.recording && this.options.recordTunnels
        ? this.buildTunnelTransaction(req, target.host, target.port)
        : null

    // 未开启 HTTPS 解密时，CONNECT 隧道也需要经过上游代理
    if (this.upstreamProxy) {
      this.connectTunnelViaUpstream(clientSocket, head, target, tx)
      return
    }

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

  /** 打开到上游代理的 TCP/TLS 连接，返回需要等待的连接事件 */
  private openUpstreamProxySocket(): { socket: net.Socket; event: 'connect' | 'secureConnect' } | null {
    const proxy = this.upstreamProxy
    if (!proxy) return null
    if (proxy.protocol === 'https:') {
      const socket = tls.connect({
        host: proxy.host,
        port: proxy.port,
        servername: net.isIP(proxy.host) ? undefined : proxy.host,
        rejectUnauthorized: !this.options.allowInsecureUpstream
      })
      return { socket, event: 'secureConnect' }
    }
    return { socket: net.connect(proxy.port, proxy.host), event: 'connect' }
  }

  /**
   * 通过上游代理建立 CONNECT 隧道。
   * 代理返回 200 后，把客户端与目标的字节流原样 pipe 起来。
   */
  private connectTunnelViaUpstream(
    clientSocket: Duplex,
    head: Buffer,
    target: { host: string; port: number },
    tx: StoredTransaction | null
  ): void {
    const opened = this.openUpstreamProxySocket()
    if (!opened) return
    const { socket: upstream, event } = opened
    const proxy = this.upstreamProxy!
    let buffered: Buffer = Buffer.alloc(0)
    let tunnelReady = false
    let failed = false

    const fail = (message: string): void => {
      if (failed || tunnelReady) return
      failed = true
      clearTimeout(timer)
      upstream.destroy()
      if (tx) this.store.finalize(tx, 'error', message)
      if (!clientSocket.destroyed) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      this.hooks.onError(`上游代理隧道建立失败：${message}`)
    }
    const timer = setTimeout(() => fail('连接上游代理超时'), 10_000)

    upstream.once(event, () => {
      if (failed || tunnelReady) return
      const host = net.isIPv6(target.host) ? `[${target.host}]` : target.host
      const lines = [`CONNECT ${host}:${target.port} HTTP/1.1`, `Host: ${host}:${target.port}`]
      if (proxy.authorization) lines.push(`Proxy-Authorization: ${proxy.authorization}`)
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    })

    const onProxyData = (chunk: Buffer): void => {
      if (tunnelReady || failed) return
      buffered = Buffer.concat([buffered, chunk])
      const headerEnd = buffered.indexOf('\r\n\r\n')
      if (headerEnd < 0) {
        if (buffered.length > 64 * 1024) fail('上游代理响应头过长')
        return
      }

      const statusLine = buffered.subarray(0, headerEnd).toString('latin1').split('\r\n')[0] ?? ''
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)
      if (!match) {
        fail('上游代理返回了无法解析的响应')
        return
      }
      const status = Number(match[1])
      if (status !== 200) {
        fail(`上游代理拒绝了 CONNECT 请求（HTTP ${status}）`)
        return
      }

      tunnelReady = true
      if (timer) clearTimeout(timer)
      upstream.off('data', onProxyData)
      const rest = buffered.subarray(headerEnd + 4)

      if (tx) {
        tx.meta.status = 200
        tx.meta.statusText = 'Connection Established'
        tx.responseHeaders = [
          ['proxy-agent', 'FakeCharles'],
          ['upstream-proxy', `${proxy.host}:${proxy.port}`]
        ]
        tx.responseHeaderSize = 0
        tx.meta.responseSize = 0
        this.store.finalize(tx, 'complete')
      }

      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: FakeCharles\r\n\r\n')
      if (head?.length) upstream.write(head)
      // 代理响应头之后的数据属于目标服务器，直接转给客户端
      if (rest.length) clientSocket.write(rest)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    }

    upstream.on('data', onProxyData)
    upstream.on('error', (error) => fail(friendlyError(error as NodeJS.ErrnoException)))
    upstream.on('close', () => {
      if (!tunnelReady && !failed) fail('上游代理连接已关闭')
      else if (!clientSocket.destroyed) clientSocket.destroy()
    })
    clientSocket.on('error', () => upstream.destroy())
    clientSocket.on('close', () => upstream.destroy())
  }

  /**
   * 对 CONNECT 执行 TLS 中间人：
   * 客户端先和本地伪造证书握手，之后 HTTP 请求以明文交给 mitmHttpServer。
   * 证书生成失败时返回 false，让调用方退回原始 TCP 隧道。
   */
  private startMitm(
    _req: http.IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
    target: { host: string; port: number }
  ): boolean {
    if (!this.ca) return false

    let leaf: { key: string; cert: string }
    try {
      leaf = this.ca.getCertificate(target.host)
    } catch (error) {
      this.hooks.onError(`HTTPS 解密证书准备失败：${friendlyError(error as NodeJS.ErrnoException)}`)
      return false
    }

    try {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: FakeCharles\r\n\r\n')
      if (head?.length) clientSocket.unshift(head)

      const secureContext = tls.createSecureContext({ key: leaf.key, cert: leaf.cert })
      const tlsSocket = new tls.TLSSocket(clientSocket as net.Socket, {
        isServer: true,
        secureContext,
        ALPNProtocols: ['http/1.1']
      })

      const timer = setTimeout(() => {
        tlsSocket.destroy(new Error('HTTPS 解密握手超时'))
      }, 10_000)

      tlsSocket.once('secure', () => {
        clearTimeout(timer)
        this.mitmTargets.set(tlsSocket, { host: target.host, port: target.port })
        try {
          this.mitmHttpServer.emit('connection', tlsSocket)
        } catch (error) {
          this.hooks.onError(`HTTPS 解密连接初始化失败：${friendlyError(error as NodeJS.ErrnoException)}`)
          tlsSocket.destroy()
        }
      })
      tlsSocket.on('error', (error) => {
        clearTimeout(timer)
        this.hooks.onError(`HTTPS 解密握手失败：${friendlyError(error as NodeJS.ErrnoException)}`)
        tlsSocket.destroy()
      })
      tlsSocket.on('close', () => clearTimeout(timer))
    } catch (error) {
      this.hooks.onError(`HTTPS 解密启动失败：${friendlyError(error as NodeJS.ErrnoException)}`)
      if (!clientSocket.destroyed) clientSocket.destroy()
    }

    return true
  }

  private onDecryptedRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const socket = req.socket as net.Socket
    const targetInfo = this.mitmTargets.get(socket)
    if (!targetInfo) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('HTTPS 解密上下文丢失')
      return
    }

    const perfStart = performance.now()
    let target: URL
    try {
      target = buildHttpsTarget(targetInfo.host, targetInfo.port, req.url || '/')
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Bad Request')
      return
    }

    const tx = this.options.recording
      ? this.buildTransaction(req, target, normalizeIp(socket.remoteAddress))
      : null
    const headers = forwardHeaders(req, target)
    this.dispatch({
      tx,
      method: req.method || 'GET',
      target,
      headers,
      incoming: req,
      clientRes: res,
      perfStart,
      secure: true
    })
  }

  /**
   * HTTPS 解密后的 WebSocket / Upgrade。
   * 客户端已经和内嵌 TLS 连接完成握手，这里把 Upgrade 请求转发给真实目标，
   * 收到 101 后把两侧字节流原样 pipe，不解析帧。
   */
  private onDecryptedUpgrade(req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    const socket = req.socket as net.Socket
    const targetInfo = this.mitmTargets.get(socket)
    if (!targetInfo) {
      clientSocket.destroy()
      return
    }

    const perfStart = performance.now()
    let target: URL
    try {
      target = buildHttpsTarget(targetInfo.host, targetInfo.port, req.url || '/')
    } catch {
      clientSocket.destroy()
      return
    }

    const targetHost = bareHostname(target.hostname)
    const tx = this.options.recording
      ? this.store.create({
          method: req.method || 'GET',
          url: target.toString(),
          host: targetHost,
          port: Number(target.port || 443),
          path: `${target.pathname}${target.search}`,
          protocol: 'https',
          clientIp: normalizeIp(socket.remoteAddress),
          decrypted: true,
          upgrade: true,
          note: 'WebSocket / Upgrade 连接（HTTPS 解密后透传，不解析帧）'
        })
      : null
    if (tx) {
      tx.requestHeaders = collectHeaders(req.rawHeaders)
      tx.requestHeaderSize =
        rawHeadersSize(req.rawHeaders) + requestLineSize(req.method || 'GET', req.url || '/')
      tx.requestEncoding = headerValue(req.rawHeaders, 'content-encoding') || undefined
      tx.meta.requestMime = headerValue(req.rawHeaders, 'content-type')
      tx.meta.requestSize = tx.requestHeaderSize
      this.store.commit(tx)
    }

    const headers = buildUpgradeHeaders(collectHeaders(req.rawHeaders), target)
    let upstreamReq: http.ClientRequest
    try {
      upstreamReq = https.request({
        protocol: 'https:',
        hostname: targetHost,
        port: Number(target.port || 443),
        method: req.method || 'GET',
        path: `${target.pathname || '/'}${target.search}`,
        headers,
        // 配置了上游代理时仍由 HttpsProxyAgent 先建立 CONNECT 隧道
        agent: this.upstreamHttpsAgent ?? false,
        rejectUnauthorized: !this.options.allowInsecureUpstream,
        servername: net.isIP(targetHost) ? undefined : targetHost,
        ...(this.options.upstreamCa ? { ca: this.options.upstreamCa } : {})
      })
    } catch (error) {
      const message = friendlyError(error as NodeJS.ErrnoException)
      if (tx) this.store.finalize(tx, 'error', message)
      writeSocketError(clientSocket, message)
      this.hooks.onError(`HTTPS WebSocket 握手失败：${message}`)
      return
    }

    let upgraded = false
    const timer = setTimeout(() => {
      upstreamReq.destroy(new Error('WebSocket 握手超时'))
    }, 30_000)

    upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      clearTimeout(timer)
      upgraded = true

      if (tx) {
        tx.meta.status = upstreamRes.statusCode ?? 101
        tx.meta.statusText = upstreamRes.statusMessage || 'Switching Protocols'
        tx.meta.responseMime = headerValue(upstreamRes.rawHeaders, 'content-type')
        tx.responseHeaders = collectHeaders(upstreamRes.rawHeaders)
        tx.responseHeaderSize = rawHeadersSize(upstreamRes.rawHeaders) + statusLineSize(upstreamRes)
        tx.responseBodySize = 0
        tx.meta.responseSize = tx.responseHeaderSize
        tx.httpVersion = `HTTP/${upstreamRes.httpVersion}`
        tx.timings.firstByteAt = Date.now()
        tx.timings.waitMs = Math.max(0, Math.round(performance.now() - perfStart))
        tx.timings.receiveMs = 0
        this.store.finalize(tx, 'complete')
      }

      writeRawResponse(
        clientSocket,
        upstreamRes.statusCode ?? 101,
        upstreamRes.statusMessage,
        upstreamRes.rawHeaders
      )
      if (upstreamHead.length) clientSocket.write(upstreamHead)
      if (head?.length) upstreamSocket.write(head)

      this.sockets.add(upstreamSocket)
      upstreamSocket.on('close', () => this.sockets.delete(upstreamSocket))
      upstreamSocket.on('error', () => clientSocket.destroy())
      clientSocket.on('error', () => upstreamSocket.destroy())
      clientSocket.on('close', () => upstreamSocket.destroy())
      upstreamSocket.pipe(clientSocket)
      clientSocket.pipe(upstreamSocket)
    })

    upstreamReq.on('response', (upstreamRes) => {
      // 非 101 响应：按普通 HTTP 响应转发给客户端，并记录状态与响应体
      clearTimeout(timer)
      const captureLimit = this.options.maxBodySize
      let captured = 0

      if (tx) {
        tx.meta.status = upstreamRes.statusCode
        tx.meta.statusText = upstreamRes.statusMessage || ''
        tx.meta.responseMime = headerValue(upstreamRes.rawHeaders, 'content-type')
        tx.responseEncoding = headerValue(upstreamRes.rawHeaders, 'content-encoding') || undefined
        tx.responseHeaders = collectHeaders(upstreamRes.rawHeaders)
        tx.responseHeaderSize = rawHeadersSize(upstreamRes.rawHeaders) + statusLineSize(upstreamRes)
        tx.responseBodySize = 0
        tx.meta.responseSize = tx.responseHeaderSize
        tx.httpVersion = `HTTP/${upstreamRes.httpVersion}`
        tx.timings.firstByteAt = Date.now()
        tx.timings.waitMs = Math.max(0, Math.round(performance.now() - perfStart))
        this.store.touch(tx)
      }

      writeRawResponse(
        clientSocket,
        upstreamRes.statusCode ?? 502,
        upstreamRes.statusMessage,
        upstreamRes.rawHeaders
      )
      upstreamRes.on('data', (chunk: Buffer) => {
        if (!tx) return
        tx.responseBodySize += chunk.length
        const room = captureLimit - captured
        if (room > 0) {
          const slice = chunk.length <= room ? chunk : chunk.subarray(0, room)
          tx.responseChunks.push(slice)
          tx.responseCapturedSize += slice.length
          captured += slice.length
        }
        if (chunk.length > room) tx.responseTruncated = true
        tx.meta.responseSize = tx.responseHeaderSize + tx.responseBodySize
      })
      upstreamRes.on('end', () => {
        if (tx) {
          tx.timings.receiveMs = Math.max(0, Date.now() - (tx.timings.firstByteAt || Date.now()))
          this.store.finalize(tx, 'complete')
        }
        if (!clientSocket.destroyed) clientSocket.end()
      })
      upstreamRes.on('error', (error) => {
        if (tx) this.store.finalize(tx, 'error', friendlyError(error))
        if (!clientSocket.destroyed) clientSocket.destroy()
      })
      upstreamRes.pipe(clientSocket)
    })

    upstreamReq.on('error', (error) => {
      clearTimeout(timer)
      if (upgraded) return
      const message = friendlyError(error)
      if (tx) this.store.finalize(tx, 'error', message)
      writeSocketError(clientSocket, message)
      this.hooks.onError(`HTTPS WebSocket 握手失败：${message}`)
    })

    clientSocket.on('error', () => upstreamReq.destroy())
    clientSocket.on('close', () => {
      if (!upgraded) {
        upstreamReq.destroy()
        if (tx) this.store.finalize(tx, 'error', '客户端提前断开连接')
      }
    })

    upstreamReq.end()
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
          upgrade: true,
          note: 'WebSocket / Upgrade 连接（仅透传，不解析内容）'
        })
      : null
    if (tx) {
      tx.requestHeaders = collectHeaders(req.rawHeaders)
      tx.requestHeaderSize = rawHeadersSize(req.rawHeaders) + requestLineSize(req.method || 'GET', rawUrl)
      tx.meta.requestSize = tx.requestHeaderSize
      this.store.commit(tx)
    }

    const proxy = this.upstreamProxy
    const connectHost = proxy ? proxy.host : bareHostname(target.hostname)
    const connectPort = proxy ? proxy.port : Number(target.port || 80)
    const connectSecure = proxy?.protocol === 'https:'
    const upstream = connectSecure
      ? tls.connect({
          host: connectHost,
          port: connectPort,
          servername: net.isIP(connectHost) ? undefined : connectHost,
          rejectUnauthorized: !this.options.allowInsecureUpstream
        })
      : net.connect(connectPort, connectHost)
    const connectEvent = connectSecure ? 'secureConnect' : 'connect'

    upstream.once(connectEvent, () => {
      // 走上游代理时使用绝对形式请求，直连时使用 origin-form
      const requestTarget = proxy
        ? `${target.protocol}//${target.host}${target.pathname}${target.search}`
        : `${target.pathname}${target.search}`
      upstream.write(`${req.method || 'GET'} ${requestTarget} HTTP/1.1\r\n`)
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]
        // Proxy-Authorization 只对代理本身有效，不能转发给目标服务器
        if (name.toLowerCase() === 'proxy-authorization') continue
        upstream.write(`${name}: ${req.rawHeaders[i + 1]}\r\n`)
      }
      if (proxy) {
        upstream.write('Proxy-Connection: keep-alive\r\n')
        if (proxy.authorization) upstream.write(`Proxy-Authorization: ${proxy.authorization}\r\n`)
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
      note: 'HTTPS 流量通过 CONNECT 隧道透传，内容未解密。如需查看具体请求，请在设置中开启 HTTPS 解密。'
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

/** Upgrade 请求需要保留 Connection / Upgrade / Sec-WebSocket-*，只剥掉与单跳代理相关的头 */
const UPGRADE_STRIP_HEADERS = new Set([
  'host',
  'proxy-connection',
  'proxy-authorization',
  'expect',
  'content-length',
  'transfer-encoding',
  'te',
  'trailer',
  'keep-alive'
])

function buildUpgradeHeaders(pairs: HeaderPair[], target: URL): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {}
  for (const [rawName, rawValue] of pairs) {
    const name = rawName.toLowerCase()
    if (UPGRADE_STRIP_HEADERS.has(name)) continue
    const current = headers[name]
    if (current === undefined) headers[name] = rawValue
    else if (Array.isArray(current)) current.push(rawValue)
    else headers[name] = [String(current), rawValue]
  }
  headers.host = target.host
  if (headers.connection === undefined) headers.connection = 'Upgrade'
  return headers
}

/** 向裸 socket 写一个完整的 HTTP 响应头（用于 Upgrade / CONNECT 透传） */
function writeRawResponse(
  socket: Duplex,
  statusCode: number,
  statusMessage: string | undefined,
  rawHeaders: string[]
): void {
  if (socket.destroyed) return
  const lines = [`HTTP/1.1 ${statusCode} ${statusMessage ?? ''}`.trimEnd()]
  for (let i = 0; i < rawHeaders.length - 1; i += 2) {
    lines.push(`${rawHeaders[i]}: ${rawHeaders[i + 1]}`)
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)
}

/** Upgrade 握手失败时向裸 socket 返回 502 */
function writeSocketError(socket: Duplex, message: string): void {
  if (socket.destroyed) return
  const body = `FakeCharles: ${message}`
  socket.end(
    `HTTP/1.1 502 Bad Gateway\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `Connection: close\r\n\r\n${body}`
  )
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

/** 根据 CONNECT 目标和解密后的请求行构造 HTTPS URL */
function buildHttpsTarget(host: string, port: number, rawUrl: string): URL {
  if (/^https?:\/\//i.test(rawUrl)) {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'https:') throw new Error('HTTPS 连接中出现了非 HTTPS 请求')
    return parsed
  }

  const hostPart = net.isIP(host) === 6 ? `[${host}]` : host
  const portPart = port === 443 ? '' : `:${port}`
  const path = rawUrl === '*' ? '/' : rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`
  return new URL(`https://${hostPart}${portPart}${path}`)
}

/** URL.hostname 对 IPv6 可能带方括号，TLS/HTTP 客户端需要去掉 */
function bareHostname(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '')
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
