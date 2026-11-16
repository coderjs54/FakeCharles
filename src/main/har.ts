import { APP_VERSION } from '../shared/defaults'
import type { BodyView, EntryDetail, HeaderPair } from '../shared/types'

interface HarHeader {
  name: string
  value: string
}

interface HarCookie {
  name: string
  value: string
  path?: string
  domain?: string
  expires?: string
  httpOnly?: boolean
  secure?: boolean
}

/** 将条目导出为 HAR 1.2，方便导入 Chrome DevTools 或其他工具 */
export function buildHar(entries: EntryDetail[]): Record<string, unknown> {
  const harEntries = entries
    .filter((entry) => !entry.tunnel && entry.method !== 'CONNECT')
    .map((entry) => {
      let queryString: Array<{ name: string; value: string }> = []
      try {
        const url = new URL(entry.url)
        queryString = [...url.searchParams.entries()].map(([name, value]) => ({ name, value }))
      } catch {
        // ignore invalid URL
      }
      const requestCookieHeader = findHeader(entry.requestHeaders, 'cookie')
      const responseCookies = parseSetCookies(entry.responseHeaders)
      const location = findHeader(entry.responseHeaders, 'location')
      const requestPostData = entry.requestBody

      return {
        startedDateTime: new Date(entry.startTime).toISOString(),
        time: entry.duration ?? 0,
        request: {
          method: entry.method,
          url: entry.url,
          httpVersion: entry.httpVersion,
          cookies: parseRequestCookies(requestCookieHeader),
          headers: entry.requestHeaders.map(toHarHeader),
          queryString,
          postData:
            requestPostData.kind === 'text' && requestPostData.text
              ? { mimeType: entry.requestMime || 'text/plain', text: requestPostData.text }
              : undefined,
          headersSize: entry.requestHeaderSize,
          bodySize: requestPostData.size
        },
        response: {
          status: entry.status ?? 0,
          statusText: entry.statusText ?? '',
          httpVersion: entry.httpVersion,
          cookies: responseCookies,
          headers: entry.responseHeaders.map(toHarHeader),
          content: buildContent(entry.responseBody, entry.responseMime),
          redirectURL: location || '',
          headersSize: entry.responseHeaderSize,
          bodySize: entry.responseBody.size
        },
        cache: {},
        timings: {
          send: 0,
          wait: entry.timings.waitMs ?? 0,
          receive: entry.timings.receiveMs ?? 0
        },
        pageref: 'page_1'
      }
    })

  return {
    log: {
      version: '1.2',
      creator: { name: 'FakeCharles', version: APP_VERSION },
      browser: { name: 'FakeCharles', version: APP_VERSION },
      pages: [{ startedDateTime: new Date(entries[0]?.startTime ?? Date.now()).toISOString(), id: 'page_1', title: 'FakeCharles Session' }],
      entries: harEntries
    }
  }
}

function buildContent(body: BodyView, mime: string): Record<string, unknown> {
  const content: Record<string, unknown> = {
    size: body.decodedSize || body.size,
    mimeType: mime || 'application/octet-stream'
  }
  if (body.kind === 'text' && body.text !== undefined) {
    content.text = body.text
  } else if (body.kind === 'binary' && body.base64) {
    content.text = body.base64
    content.encoding = 'base64'
  }
  return content
}

function toHarHeader([name, value]: HeaderPair): HarHeader {
  return { name, value }
}

function findHeader(headers: HeaderPair[], name: string): string {
  const lower = name.toLowerCase()
  const found = headers.find(([key]) => key.toLowerCase() === lower)
  return found?.[1] ?? ''
}

function parseRequestCookies(cookieHeader: string): HarCookie[] {
  if (!cookieHeader) return []
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf('=')
      return index > 0
        ? { name: part.slice(0, index), value: part.slice(index + 1) }
        : { name: part, value: '' }
    })
}

function parseSetCookies(headers: HeaderPair[]): HarCookie[] {
  const cookies: HarCookie[] = []
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== 'set-cookie') continue
    const segments = value.split(';').map((part) => part.trim())
    const first = segments.shift() ?? ''
    const index = first.indexOf('=')
    if (index <= 0) continue
    const cookie: HarCookie = { name: first.slice(0, index), value: first.slice(index + 1) }
    for (const segment of segments) {
      const [rawKey, rawValue] = segment.split('=')
      const key = rawKey.trim().toLowerCase()
      if (key === 'path') cookie.path = rawValue?.trim()
      else if (key === 'domain') cookie.domain = rawValue?.trim()
      else if (key === 'expires') {
        const expires = new Date(rawValue?.trim() ?? '')
        if (!Number.isNaN(expires.getTime())) cookie.expires = expires.toISOString()
      }
      else if (key === 'httponly') cookie.httpOnly = true
      else if (key === 'secure') cookie.secure = true
    }
    cookies.push(cookie)
  }
  return cookies
}
