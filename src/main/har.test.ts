import { describe, expect, it } from 'vitest'
import type { BodyView, EntryDetail } from '../shared/types'
import { buildHar } from './har'

function bodyView(overrides: Partial<BodyView> = {}): BodyView {
  return {
    available: true,
    size: 0,
    capturedSize: 0,
    decodedSize: 0,
    truncated: false,
    textTruncated: false,
    kind: 'empty',
    mime: '',
    ...overrides
  }
}

function entryDetail(overrides: Partial<EntryDetail> = {}): EntryDetail {
  return {
    id: 'entry-1',
    seq: 1,
    startTime: Date.parse('2026-01-02T03:04:05.000Z'),
    method: 'POST',
    url: 'http://example.com/api/users?page=2&tag=a',
    host: 'example.com',
    port: 80,
    path: '/api/users?page=2&tag=a',
    protocol: 'http',
    clientIp: '127.0.0.1',
    status: 200,
    statusText: 'OK',
    state: 'complete',
    requestSize: 100,
    responseSize: 200,
    duration: 42,
    requestMime: 'application/json',
    responseMime: 'application/json',
    tunnel: false,
    requestHeaders: [
      ['content-type', 'application/json'],
      ['cookie', 'sid=abc; theme=dark']
    ],
    responseHeaders: [
      ['content-type', 'application/json'],
      ['set-cookie', 'token=xyz; Path=/; HttpOnly']
    ],
    requestHeaderSize: 60,
    responseHeaderSize: 70,
    requestBody: bodyView({
      kind: 'text',
      mime: 'application/json',
      text: '{"name":"demo"}',
      size: 16,
      decodedSize: 16
    }),
    responseBody: bodyView({
      kind: 'text',
      mime: 'application/json',
      text: '{"ok":true}',
      size: 11,
      decodedSize: 11
    }),
    timings: { startedAt: Date.parse('2026-01-02T03:04:05.000Z'), waitMs: 30, receiveMs: 12 },
    httpVersion: 'HTTP/1.1',
    ...overrides
  }
}

describe('buildHar', () => {
  it('输出合法的 HAR 1.2 结构', () => {
    const har = buildHar([entryDetail()]) as any

    expect(har.log.version).toBe('1.2')
    expect(har.log.creator.name).toBe('FakeCharles')
    expect(har.log.entries).toHaveLength(1)

    const entry = har.log.entries[0]
    expect(entry.request.method).toBe('POST')
    expect(entry.request.queryString).toEqual([
      { name: 'page', value: '2' },
      { name: 'tag', value: 'a' }
    ])
    expect(entry.request.postData.text).toBe('{"name":"demo"}')
    expect(entry.request.cookies).toEqual([
      { name: 'sid', value: 'abc' },
      { name: 'theme', value: 'dark' }
    ])
    expect(entry.response.status).toBe(200)
    expect(entry.response.content.text).toBe('{"ok":true}')
    expect(entry.response.cookies[0]).toMatchObject({ name: 'token', value: 'xyz', httpOnly: true })
    expect(entry.timings.wait).toBe(30)
    expect(entry.timings.receive).toBe(12)
  })

  it('跳过 CONNECT 隧道和未解密的 HTTPS 条目', () => {
    const har = buildHar([
      entryDetail(),
      entryDetail({ id: 'entry-2', method: 'CONNECT', tunnel: true })
    ]) as any

    expect(har.log.entries).toHaveLength(1)
  })

  it('二进制响应使用 base64 输出', () => {
    const har = buildHar([
      entryDetail({
        responseMime: 'image/png',
        responseBody: bodyView({
          kind: 'binary',
          mime: 'image/png',
          base64: 'AAECAw==',
          size: 4,
          decodedSize: 4
        })
      })
    ]) as any

    expect(har.log.entries[0].response.content).toMatchObject({
      text: 'AAECAw==',
      encoding: 'base64',
      mimeType: 'image/png'
    })
  })
})
