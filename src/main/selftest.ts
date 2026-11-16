import { app, nativeImage, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { buildHar } from './har'
import type { CaptureProxy } from './proxy-server'
import { SessionStore } from './session-store'
import { notifySystemProxyChange, readRegistryValue, SystemProxyManager } from './system-proxy'

interface SelfTestOptions {
  window: BrowserWindow
  proxy: CaptureProxy
  store: SessionStore
  rootDir: string
}

interface Check {
  name: string
  ok: boolean
  detail?: string
}

const PNG_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const USERS_JSON = {
  page: 2,
  total: 2,
  users: [
    { id: 1, name: 'Ada Lovelace', role: 'admin', email: 'ada@example.com' },
    { id: 2, name: '林清', role: 'member', email: 'lin@example.com' }
  ]
}

/** 启动一个仅用于自测的本地 HTTP 目标服务器 */
function startTargetServer(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const sendJson = (status: number, data: unknown, extra: Record<string, string | number> = {}): void => {
      const text = JSON.stringify(data, null, 2)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra })
      res.end(text)
    }

    if (url.pathname === '/api/users') {
      const gz = gzipSync(Buffer.from(JSON.stringify(USERS_JSON, null, 2), 'utf8'))
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-encoding': 'gzip',
        'content-length': gz.length,
        'x-demo': 'gzip'
      })
      res.end(gz)
      return
    }

    if (url.pathname === '/api/login' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
      req.on('end', () => {
        let parsed: unknown = null
        try {
          parsed = JSON.parse(body || '{}')
        } catch {
          parsed = body
        }
        sendJson(200, { ok: true, received: parsed })
      })
      return
    }

    if (url.pathname === '/text/hello') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('你好，FakeCharles！这是一条 HTTP 明文请求。')
      return
    }

    if (url.pathname === '/html/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><body><h1>FakeCharles</h1><p>HTML preview</p></body></html>')
      return
    }

    if (url.pathname === '/image/logo') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG_PIXEL.length })
      res.end(PNG_PIXEL)
      return
    }

    if (url.pathname === '/error') {
      sendJson(500, { error: 'boom', message: '自测用错误响应' })
      return
    }

    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/api/users', 'content-type': 'text/plain; charset=utf-8' })
      res.end('redirecting')
      return
    }

    if (url.pathname === '/cookies') {
      res.writeHead(200, [
        'content-type',
        'application/json; charset=utf-8',
        'set-cookie',
        'token=demo123; Path=/; HttpOnly',
        'set-cookie',
        'theme=light; Path=/'
      ])
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (url.pathname === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('slow response')
      }, 350)
      return
    }

    if (url.pathname === '/chunked') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.write('chunk-one;')
      setTimeout(() => res.end('chunk-two'), 120)
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('无法获取目标服务器端口'))
        return
      }
      resolve({ server, port: address.port })
    })
  })
}

function startEchoServer(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer((socket) => {
    socket.pipe(socket)
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('无法获取回显服务器端口'))
        return
      }
      resolve({ server, port: address.port })
    })
  })
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('无法分配空闲端口'))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function requestViaProxy(
  proxyPort: number,
  targetPort: number,
  path: string,
  options: { method?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: options.method ?? 'GET',
        path: `http://127.0.0.1:${targetPort}${path}`,
        headers: {
          host: `127.0.0.1:${targetPort}`,
          connection: 'close',
          ...options.headers
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      }
    )
    req.setTimeout(10_000, () => req.destroy(new Error('自测代理请求超时')))
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

/** 验证 CONNECT 隧道透传能力 */
function testTunnel(proxyPort: number, echoPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`)
    })
    let received = ''
    let sent = false
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 4000)
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8')
      if (!sent && received.includes('200 Connection Established')) {
        sent = true
        socket.write('PING-TUNNEL')
      }
      if (received.includes('PING-TUNNEL')) {
        clearTimeout(timer)
        socket.destroy()
        resolve(true)
      }
    })
    socket.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000, interval = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(interval)
  }
  return false
}

async function waitForSelector(check: () => Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(120)
  }
  return false
}

export async function runSelfTest(options: SelfTestOptions): Promise<number> {
  const { window, proxy, store, rootDir } = options
  const outDir = join(rootDir, '.selftest')
  mkdirSync(outDir, { recursive: true })
  const checks: Check[] = []
  let target: Awaited<ReturnType<typeof startTargetServer>> | null = null
  let echo: Awaited<ReturnType<typeof startEchoServer>> | null = null
  let proxyPort = 0

  const check = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, detail })
    console.log(`[selftest] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  }

  const exec = <T>(script: string): Promise<T> => window.webContents.executeJavaScript(script, true) as Promise<T>

  const timeout = setTimeout(() => {
    console.error('[selftest] global timeout')
    app.exit(1)
  }, 60_000)

  try {
    await sleep(600)
    const emptyReady = await waitForSelector(
      () => exec<boolean>(`Boolean(document.querySelector('.fc-detail-empty'))`),
      3000
    )
    check('空状态引导渲染', emptyReady)
    if (emptyReady) {
      const emptyShot = await window.webContents.capturePage()
      writeFileSync(join(outDir, 'screenshot-empty.png'), emptyShot.toPNG())
    }

    const iconPng = nativeImage.createFromPath(join(rootDir, 'resources', 'icon.png'))
    const iconIco = nativeImage.createFromPath(join(rootDir, 'resources', 'icon.ico'))
    check(
      '应用图标资源可用',
      !iconPng.isEmpty() && !iconIco.isEmpty(),
      `${iconPng.getSize().width}px PNG / ICO`
    )

    target = await startTargetServer()
    echo = await startEchoServer()
    proxyPort = await getFreePort()
    await proxy.start(proxyPort)
    check('代理服务启动', proxy.getStatus().running && proxy.getStatus().port === proxyPort, `端口 ${proxyPort}`)

    const directPage = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http
        .get(
          { host: '127.0.0.1', port: proxyPort, path: '/', headers: { host: `127.0.0.1:${proxyPort}` } },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
          }
        )
        .on('error', reject)
    })
    check('直接访问代理端口返回说明页', directPage.status === 200 && directPage.body.includes('FakeCharles'))

    const requests: Array<{ path: string; method?: string; body?: string; headers?: Record<string, string> }> = [
      { path: '/api/users' },
      {
        path: '/api/login',
        method: 'POST',
        body: JSON.stringify({ username: 'demo', password: 'secret' }),
        headers: { 'content-type': 'application/json' }
      },
      { path: '/text/hello' },
      { path: '/html/page' },
      { path: '/image/logo' },
      { path: '/error' },
      { path: '/redirect' },
      { path: '/cookies' },
      { path: '/slow' },
      { path: '/chunked' }
    ]

    const responses: number[] = []
    for (const item of requests) {
      const res = await requestViaProxy(proxyPort, target.port, item.path, item)
      responses.push(res.status)
    }
    check('通过代理发送 10 个 HTTP 请求', responses.length === 10, responses.join(','))
    check(
      '代理正确转发状态码',
      responses[0] === 200 && responses[5] === 500 && responses[6] === 302,
      `users=${responses[0]}, error=${responses[5]}, redirect=${responses[6]}`
    )

    await waitFor(() => store.list().length >= requests.length, 5000)
    check('会话捕获到全部请求', store.list().length >= requests.length, `捕获 ${store.list().length} 条`)

    const metas = store.list()
    const usersMeta = metas.find((item) => item.url.includes('/api/users'))
    const loginMeta = metas.find((item) => item.url.includes('/api/login'))
    const imageMeta = metas.find((item) => item.url.includes('/image/logo'))
    const htmlMeta = metas.find((item) => item.url.includes('/html/page'))
    check('请求元数据包含状态码', usersMeta?.status === 200, `status=${usersMeta?.status}`)
    check('识别 gzip 响应内容类型', Boolean(usersMeta?.responseMime.includes('application/json')), usersMeta?.responseMime)

    const usersTx = usersMeta ? store.get(usersMeta.id) : undefined
    const usersDetail = usersTx ? await store.toDetail(usersTx) : null
    check(
      'gzip 响应体可解码查看',
      Boolean(usersDetail?.responseBody.text?.includes('Ada Lovelace')),
      usersDetail?.responseBody.kind
    )
    const imageTx = imageMeta ? store.get(imageMeta.id) : undefined
    const imageDetail = imageTx ? await store.toDetail(imageTx) : null
    check('二进制响应识别为图片', imageDetail?.responseBody.kind === 'binary', imageDetail?.responseBody.mime)
    const loginTx = loginMeta ? store.get(loginMeta.id) : undefined
    const loginDetail = loginTx ? await store.toDetail(loginTx) : null
    check('请求体被完整捕获', Boolean(loginDetail?.requestBody.text?.includes('demo')), loginDetail?.requestBody.text?.slice(0, 40))

    const chunkedMeta = metas.find((item) => item.url.includes('/chunked'))
    const chunkedTx = chunkedMeta ? store.get(chunkedMeta.id) : undefined
    const chunkedDetail = chunkedTx ? await store.toDetail(chunkedTx) : null
    check(
      'chunked 响应完整捕获',
      chunkedDetail?.responseBody.text === 'chunk-one;chunk-two',
      chunkedDetail?.responseBody.text
    )

    // Compose 发送
    const composed = proxy.compose({
      method: 'POST',
      url: `http://127.0.0.1:${target.port}/api/login`,
      headers: 'Content-Type: application/json\nX-Source: compose',
      body: JSON.stringify({ from: 'compose' })
    })
    await waitFor(() => store.get(composed.id)?.meta.state === 'complete', 5000)
    const composedDetail = store.get(composed.id) ? await store.toDetail(store.get(composed.id)!) : null
    check(
      'Compose 手动请求可发送并捕获',
      composedDetail?.status === 200 && Boolean(composedDetail.responseBody.text?.includes('compose')),
      `status=${composedDetail?.status}`
    )

    await sleep(700)
    const rowCount = await exec<number>(`document.querySelectorAll('[data-entry-id]').length`)
    check('界面渲染请求列表', rowCount >= 11, `DOM 行数 ${rowCount}`)

    if (usersMeta) {
      await exec(`(() => { const el = document.querySelector('[data-entry-id="${usersMeta.id}"]'); if (el) el.click(); return Boolean(el) })()`)
      await sleep(400)
      const detailUrl = await exec<string>(`document.querySelector('[data-testid="detail-url"]')?.textContent?.trim() ?? ''`)
      check('点击列表项后在详情面板显示 URL', detailUrl.includes('/api/users'), detailUrl)

      await exec(`document.querySelector('[data-testid="tab-response"]')?.click()`)
      await sleep(150)
      await exec(`document.querySelector('[data-testid="subtab-body"]')?.click()`)
      await sleep(350)
      const bodyText = await exec<string>(`document.querySelector('[data-testid="body-text"]')?.textContent ?? ''`)
      check('详情面板展示 JSON 响应内容', bodyText.includes('Ada Lovelace') && bodyText.includes('林清'), `${bodyText.length} 字符`)

      await sleep(300)
      const image = await window.webContents.capturePage()
      writeFileSync(join(outDir, 'screenshot-response.png'), image.toPNG())

      await exec(`document.querySelector('[data-testid="tab-overview"]')?.click()`)
      await sleep(250)
      const overview = await window.webContents.capturePage()
      writeFileSync(join(outDir, 'screenshot-overview.png'), overview.toPNG())
    }

    // Sequence 视图
    await exec(`document.querySelector('[data-testid="view-sequence"]')?.click()`)
    await sleep(450)
    const sequenceRows = await exec<number>(`document.querySelectorAll('[data-entry-id]').length`)
    const sequenceHeader = await exec<string>(`document.querySelector('.fc-list-header--sequence')?.textContent ?? ''`)
    check(
      'Sequence 视图渲染',
      sequenceRows >= 10 && sequenceHeader.includes('Duration'),
      `${sequenceRows} 行`
    )
    const sequenceShot = await window.webContents.capturePage()
    writeFileSync(join(outDir, 'screenshot-sequence.png'), sequenceShot.toPNG())
    await exec(`document.querySelector('[data-testid="view-structure"]')?.click()`)
    await sleep(300)

    // 右键菜单
    if (usersMeta) {
      await exec(`(() => {
        const el = document.querySelector('[data-entry-id="${usersMeta.id}"]');
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 100, clientY: rect.top + 12 }));
        return true;
      })()`)
      const menuReady = await waitForSelector(() => exec<boolean>(`Boolean(document.querySelector('.fc-context-menu'))`), 2000)
      check('请求右键菜单可用', menuReady)
      if (menuReady) {
        await sleep(150)
        const menuShot = await window.webContents.capturePage()
        writeFileSync(join(outDir, 'screenshot-context-menu.png'), menuShot.toPNG())
      }
      await exec(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
      await sleep(200)
    }

    // 设置对话框
    await exec(`document.querySelector('button[title^="设置"]')?.click()`)
    const settingsReady = await waitForSelector(() => exec<boolean>(`Boolean(document.querySelector('.fc-modal'))`), 2000)
    const settingsTitle = await exec<string>(`document.querySelector('.fc-modal-title')?.textContent ?? ''`)
    check('设置对话框可打开', settingsReady && settingsTitle.includes('代理设置'), settingsTitle)
    if (settingsReady) {
      await sleep(250)
      const settingsShot = await window.webContents.capturePage()
      writeFileSync(join(outDir, 'screenshot-settings.png'), settingsShot.toPNG())
      await exec(`document.querySelector('.fc-modal-close')?.click()`)
      await sleep(250)
    }

    // Compose 对话框
    await exec(`document.querySelector('button[title^="新建请求"]')?.click()`)
    const composeReady = await waitForSelector(() => exec<boolean>(`Boolean(document.querySelector('.fc-modal'))`), 2000)
    const composeTitle = await exec<string>(`document.querySelector('.fc-modal-title')?.textContent ?? ''`)
    check('Compose 对话框可打开', composeReady && composeTitle.includes('新建请求'), composeTitle)
    if (composeReady) {
      await sleep(250)
      const composeShot = await window.webContents.capturePage()
      writeFileSync(join(outDir, 'screenshot-compose.png'), composeShot.toPNG())
      await exec(`document.querySelector('.fc-modal-close')?.click()`)
      await sleep(250)
    }

    if (loginMeta) {
      await exec(`(() => { const el = document.querySelector('[data-entry-id="${loginMeta.id}"]'); if (el) el.click(); return Boolean(el) })()`)
      await sleep(300)
      await exec(`document.querySelector('[data-testid="tab-request"]')?.click()`)
      await sleep(150)
      await exec(`document.querySelector('[data-testid="subtab-body"]')?.click()`)
      await sleep(300)
      const reqBody = await exec<string>(`document.querySelector('[data-testid="body-text"]')?.textContent ?? ''`)
      check('详情面板展示请求体', reqBody.includes('demo'), `${reqBody.length} 字符`)
    }

    // HTML 预览
    if (htmlMeta) {
      await exec(`document.querySelector('[data-entry-id="${htmlMeta.id}"]')?.click()`)
      await sleep(300)
      await exec(`document.querySelector('[data-testid="tab-response"]')?.click()`)
      await sleep(150)
      await exec(`document.querySelector('[data-testid="subtab-body"]')?.click()`)
      await sleep(600)
      const htmlDebug = await exec<string>(`JSON.stringify({
        url: document.querySelector('[data-testid="detail-url"]')?.textContent,
        mime: document.querySelector('.fc-body-mime')?.textContent,
        buttons: [...document.querySelectorAll('.fc-body-segment-button')].map((item) => item.textContent?.trim())
      })`)
      await exec(`(() => {
        const button = [...document.querySelectorAll('.fc-body-segment-button')].find((item) => item.textContent?.trim() === '预览');
        if (button) button.click();
      })()`)
      await sleep(450)
      const hasFrame = await exec<boolean>(`Boolean(document.querySelector('iframe.fc-body-frame'))`)
      check('HTML 响应可安全预览', hasFrame, hasFrame ? undefined : htmlDebug)
      if (hasFrame) {
        const htmlShot = await window.webContents.capturePage()
        writeFileSync(join(outDir, 'screenshot-html.png'), htmlShot.toPNG())
      }
    }

    // 图片预览
    if (imageMeta) {
      await exec(`document.querySelector('[data-entry-id="${imageMeta.id}"]')?.click()`)
      await sleep(300)
      await exec(`document.querySelector('[data-testid="tab-response"]')?.click()`)
      await sleep(150)
      await exec(`document.querySelector('[data-testid="subtab-body"]')?.click()`)
      await sleep(300)
      const hasImage = await exec<boolean>(`Boolean(document.querySelector('img.fc-body-image'))`)
      check('图片响应可预览', hasImage)
      const imageShot = await window.webContents.capturePage()
      writeFileSync(join(outDir, 'screenshot-image.png'), imageShot.toPNG())
    }

    // Raw 视图
    if (usersMeta) {
      await exec(`document.querySelector('[data-entry-id="${usersMeta.id}"]')?.click()`)
      await sleep(300)
      await exec(`document.querySelector('[data-testid="tab-response"]')?.click()`)
      await sleep(150)
      await exec(`document.querySelector('[data-testid="subtab-raw"]')?.click()`)
      await sleep(250)
      const rawText = await exec<string>(`document.querySelector('[data-testid="raw-text"]')?.textContent ?? ''`)
      check('Raw 原始报文视图', rawText.includes('HTTP/1.1 200'), `${rawText.length} 字符`)
    }

    // 过滤
    await exec(`(() => {
      const input = document.querySelector('[data-testid="filter-input"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'login');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    await sleep(350)
    const filteredRows = await exec<number>(`document.querySelectorAll('[data-entry-id]').length`)
    check('过滤请求列表', filteredRows >= 1 && filteredRows < rowCount, `过滤后 ${filteredRows} 行`)
    const filterShot = await window.webContents.capturePage()
    writeFileSync(join(outDir, 'screenshot-filter.png'), filterShot.toPNG())
    await exec(`(() => {
      const input = document.querySelector('[data-testid="filter-input"]');
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await sleep(200)

    // 重放
    if (usersMeta) {
      const before = store.list().length
      const repeated = proxy.resend(usersMeta.id)
      const completed = await waitFor(() => store.get(repeated.id)?.meta.state === 'complete', 5000)
      const repeatedDetail = store.get(repeated.id) ? await store.toDetail(store.get(repeated.id)!) : null
      check(
        '重放请求并生成新条目',
        completed && store.list().length === before + 1 && Boolean(repeatedDetail?.responseBody.text?.includes('Ada Lovelace')),
        repeatedDetail?.note
      )
    }

    if (loginMeta) {
      const repeatedLogin = proxy.resend(loginMeta.id)
      await waitFor(() => store.get(repeatedLogin.id)?.meta.state === 'complete', 5000)
      const repeatedLoginDetail = store.get(repeatedLogin.id) ? await store.toDetail(store.get(repeatedLogin.id)!) : null
      check(
        '重放 POST 请求保留请求体',
        Boolean(repeatedLoginDetail?.requestBody.text?.includes('demo')) &&
          Boolean(repeatedLoginDetail?.responseBody.text?.includes('"ok": true')),
        `status=${repeatedLoginDetail?.status}`
      )
    }

    // 会话序列化往返
    const exported = store.exportSession()
    const tempStore = new SessionStore({ onAdd: () => {}, onUpdate: () => {}, onRemove: () => {}, onClear: () => {} }, 1000)
    const importedMetas = tempStore.importSession(JSON.parse(JSON.stringify(exported)) as typeof exported)
    const importedUsers = importedMetas.find((item) => item.url.includes('/api/users') && !item.repeatOf)
    const importedTx = importedUsers ? tempStore.get(importedUsers.id) : undefined
    const importedDetail = importedTx ? await tempStore.toDetail(importedTx) : null
    check(
      '会话保存/加载数据往返',
      importedMetas.length === exported.entries.length &&
        importedDetail?.status === 200 &&
        typeof importedDetail?.duration === 'number' &&
        Boolean(importedDetail?.responseBody.text?.includes('Ada Lovelace')),
      `${importedMetas.length} 条`
    )

    const har = buildHar(usersDetail ? [usersDetail] : [])
    const harEntries = (
      har.log as {
        entries: Array<{ request: { url: string }; response: { content: { text?: string } } }>
      }
    ).entries
    check(
      'HAR 导出结构有效',
      harEntries.length === 1 &&
        harEntries[0].request.url.includes('/api/users') &&
        Boolean(harEntries[0].response.content.text?.includes('Ada Lovelace'))
    )

    // CONNECT 隧道
    const tunnelOk = await testTunnel(proxyPort, echo.port)
    const tunnelEntry = store.list().find((item) => item.tunnel)
    check('HTTPS CONNECT 隧道透传并记录提示', tunnelOk && Boolean(tunnelEntry), tunnelEntry?.note?.slice(0, 20))

    // 会话列表仍可交互
    const finalRows = await exec<number>(`document.querySelectorAll('[data-entry-id]').length`)
    check('隧道条目进入列表', finalRows > rowCount, `最终 ${finalRows} 行`)

    // HTTPS 过滤开关
    if (tunnelEntry) {
      const tunnelVisible = await exec<boolean>(
        `Boolean(document.querySelector('[data-entry-id="${tunnelEntry.id}"]'))`
      )
      check('HTTPS 请求在列表中可见', tunnelVisible)

      await exec(`document.querySelector('[data-testid="https-filter"]')?.click()`)
      await sleep(350)
      const hiddenTunnel = await exec<boolean>(
        `!document.querySelector('[data-entry-id="${tunnelEntry.id}"]')`
      )
      const hiddenRows = await exec<number>(`document.querySelectorAll('[data-entry-id]').length`)
      check('HTTPS 过滤隐藏 HTTPS 请求', hiddenTunnel && hiddenRows < finalRows, `${hiddenRows}/${finalRows} 行`)
      const hiddenShot = await window.webContents.capturePage()
      writeFileSync(join(outDir, 'screenshot-https-hidden.png'), hiddenShot.toPNG())

      await exec(`document.querySelector('[data-testid="https-filter"]')?.click()`)
      await sleep(350)
      const shownTunnel = await exec<boolean>(
        `Boolean(document.querySelector('[data-entry-id="${tunnelEntry.id}"]'))`
      )
      const shownRows = await exec<number>(`document.querySelectorAll('[data-entry-id]').length`)
      check('HTTPS 过滤恢复显示 HTTPS 请求', shownTunnel && shownRows === finalRows, `${shownRows} 行`)
    }

    // 暂停记录：请求仍然转发，但不写入会话
    const pausedCount = store.list().length
    proxy.setRecording(false)
    const pausedResponse = await requestViaProxy(proxyPort, target.port, '/text/hello')
    await sleep(200)
    check(
      '暂停记录后请求仍转发但不入库',
      pausedResponse.status === 200 && store.list().length === pausedCount,
      `${pausedCount} 条`
    )
    proxy.setRecording(true)

    // 停止 / 重启代理
    await proxy.stop()
    check('停止代理', proxy.getStatus().running === false)
    await proxy.start(proxyPort)
    check('重新启动代理', proxy.getStatus().running === true)

    // 系统代理接管逻辑使用独立注册表键测试，避免修改真实系统代理
    if (process.platform === 'win32') {
      const testKey = `HKCU\\Software\\FakeCharles\\SelfTest-${process.pid}`
      const testBackup = join(outDir, 'system-proxy-test.json')
      const readValue = (name: string): string | null => readRegistryValue(testKey, name)?.value ?? null
      const seed = (name: string, type: string, value: string): void => {
        execFileSync('reg', ['add', testKey, '/v', name, '/t', type, '/d', value, '/f'], {
          windowsHide: true,
          stdio: 'ignore'
        })
      }

      try {
        execFileSync('reg', ['delete', testKey, '/f'], { windowsHide: true, stdio: 'ignore' })
      } catch {
        // 测试键本来就不存在
      }

      try {
        seed('ProxyEnable', 'REG_DWORD', '0')
        seed('ProxyServer', 'REG_SZ', 'original.proxy:8080')
        seed('ProxyOverride', 'REG_SZ', '<local>')
        seed('AutoConfigURL', 'REG_SZ', 'http://pac.example/proxy.pac')

        const manager = new SystemProxyManager(testBackup, { registryKey: testKey, notify: false })
        const applied = manager.apply(18888)
        check(
          '系统代理自动接管（测试键）',
          applied.active &&
            applied.server === '127.0.0.1:18888' &&
            readValue('ProxyEnable') === '0x1' &&
            readValue('ProxyServer') === '127.0.0.1:18888' &&
            readValue('AutoConfigURL') === null
        )

        manager.apply(18889)
        check('系统代理端口更新（测试键）', readValue('ProxyServer') === '127.0.0.1:18889')

        manager.restore()
        check(
          '系统代理恢复用户原值（测试键）',
          readValue('ProxyEnable') === '0x0' &&
            readValue('ProxyServer') === 'original.proxy:8080' &&
            readValue('AutoConfigURL') === 'http://pac.example/proxy.pac' &&
            !existsSync(testBackup)
        )

        // 模拟崩溃：接管后不调用 restore，下一次启动通过备份自动恢复
        const crashed = new SystemProxyManager(testBackup, { registryKey: testKey, notify: false })
        crashed.apply(18890)
        const nextLaunch = new SystemProxyManager(testBackup, { registryKey: testKey, notify: false })
        nextLaunch.recover()
        check(
          '异常退出后启动恢复系统代理（测试键）',
          readValue('ProxyServer') === 'original.proxy:8080' &&
            readValue('AutoConfigURL') === 'http://pac.example/proxy.pac'
        )

        // 其他程序改过系统代理时，不应该强行覆盖
        const guarded = new SystemProxyManager(testBackup, { registryKey: testKey, notify: false })
        guarded.apply(18891)
        seed('ProxyServer', 'REG_SZ', 'other.proxy:9999')
        guarded.restore()
        check('外部修改后不覆盖系统代理（测试键）', readValue('ProxyServer') === 'other.proxy:9999')

        check('系统代理刷新通知可用', notifySystemProxyChange())
      } finally {
        try {
          execFileSync('reg', ['delete', testKey, '/f'], { windowsHide: true, stdio: 'ignore' })
        } catch {
          // ignore
        }
        rmSync(testBackup, { force: true })
      }
    }

    const result = {
      ok: checks.every((item) => item.ok),
      ranAt: new Date().toISOString(),
      proxyPort,
      targetPort: target.port,
      captured: store.list().length,
      checks,
      screenshots: [
        'screenshot-empty.png',
        'screenshot-response.png',
        'screenshot-overview.png',
        'screenshot-sequence.png',
        'screenshot-context-menu.png',
        'screenshot-settings.png',
        'screenshot-compose.png',
        'screenshot-html.png',
        'screenshot-image.png',
        'screenshot-https-hidden.png',
        'screenshot-filter.png'
      ]
    }
    writeFileSync(join(outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8')
    console.log(`[selftest] ${result.ok ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}`)
    return result.ok ? 0 : 1
  } catch (error) {
    console.error('[selftest] error:', error)
    const result = { ok: false, error: (error as Error).stack ?? String(error), checks }
    writeFileSync(join(outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8')
    try {
      const image = await window.webContents.capturePage()
      writeFileSync(join(outDir, 'screenshot-error.png'), image.toPNG())
    } catch {
      // ignore
    }
    return 1
  } finally {
    clearTimeout(timeout)
    await proxy.stop(true)
    target?.server.close()
    echo?.server.close()
  }
}
