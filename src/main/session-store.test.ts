import { describe, expect, it } from 'vitest'
import { SessionStore } from './session-store'

function createStore(maxEntries = 100, maxSessionBytes = 1024 * 1024) {
  const removed: string[] = []
  const store = new SessionStore(
    {
      onAdd: () => {},
      onUpdate: () => {},
      onRemove: (id) => removed.push(id),
      onClear: () => {}
    },
    maxEntries,
    maxSessionBytes
  )
  return { store, removed }
}

function makeTransaction(store: SessionStore, headers: number, requestBytes: number, responseBytes: number) {
  const tx = store.create({
    method: 'GET',
    url: 'http://example.com/api',
    host: 'example.com',
    port: 80,
    path: '/api',
    protocol: 'http',
    clientIp: '127.0.0.1'
  })
  tx.requestHeaderSize = headers
  tx.requestCapturedSize = requestBytes
  tx.responseCapturedSize = responseBytes
  store.commit(tx)
  return tx
}

describe('SessionStore 内存预算', () => {
  it('超过总预算时淘汰最旧条目', () => {
    const { store, removed } = createStore(100, 1000)
    const first = makeTransaction(store, 100, 400, 400)
    const second = makeTransaction(store, 100, 400, 400)

    expect(store.list()).toHaveLength(1)
    expect(store.list()[0].id).toBe(second.meta.id)
    expect(removed).toContain(first.meta.id)
  })

  it('单条超过预算时仍然保留最新一条', () => {
    const { store } = createStore(100, 1000)
    makeTransaction(store, 100, 400, 400)
    const big = makeTransaction(store, 100, 3000, 3000)

    expect(store.list()).toHaveLength(1)
    expect(store.list()[0].id).toBe(big.meta.id)
  })

  it('finalize 后释放分块并合并 Body', () => {
    const { store } = createStore()
    const tx = store.create({
      method: 'POST',
      url: 'http://example.com/body',
      host: 'example.com',
      port: 80,
      path: '/body',
      protocol: 'http',
      clientIp: '127.0.0.1'
    })
    tx.requestChunks = [Buffer.from('hello '), Buffer.from('world')]
    tx.responseChunks = [Buffer.from('resp')]
    tx.requestBodySize = 11
    tx.responseBodySize = 4
    store.commit(tx)
    store.finalize(tx, 'complete')

    expect(tx.requestBody?.toString()).toBe('hello world')
    expect(tx.responseBody?.toString()).toBe('resp')
    expect(tx.requestChunks).toHaveLength(0)
    expect(tx.responseChunks).toHaveLength(0)
  })
})

describe('SessionStore 详情与按需 Body', () => {
  it('大 Body 返回 deferred 占位，并可单独获取完整内容', async () => {
    const { store } = createStore()
    const tx = store.create({
      method: 'GET',
      url: 'http://example.com/large',
      host: 'example.com',
      port: 80,
      path: '/large',
      protocol: 'http',
      clientIp: '127.0.0.1'
    })
    tx.requestHeaderSize = 10
    tx.responseHeaderSize = 10
    tx.requestBody = Buffer.from('small')
    tx.requestBodySize = 5
    tx.requestCapturedSize = 5
    tx.responseBody = Buffer.from('x'.repeat(100))
    tx.responseBodySize = 100
    tx.responseCapturedSize = 100
    store.commit(tx)
    store.finalize(tx, 'complete')

    const detail = await store.toDetail(tx, { lazyBodyThreshold: 10 })

    expect(detail.requestBody.deferred).toBeUndefined()
    expect(detail.requestBody.text).toBe('small')
    expect(detail.responseBody.deferred).toBe(true)
    expect(detail.responseBody.text).toBeUndefined()

    const fullResponse = await store.getBodyView(tx.meta.id, 'response')
    expect(fullResponse?.text).toHaveLength(100)
    expect(fullResponse?.deferred).toBeUndefined()
  })

  it('小 Body 详情会写入缓存', async () => {
    const { store } = createStore()
    const tx = store.create({
      method: 'GET',
      url: 'http://example.com/small',
      host: 'example.com',
      port: 80,
      path: '/small',
      protocol: 'http',
      clientIp: '127.0.0.1'
    })
    tx.requestHeaderSize = 10
    tx.responseHeaderSize = 10
    tx.requestBody = Buffer.from('req')
    tx.responseBody = Buffer.from('resp')
    tx.requestBodySize = 3
    tx.responseBodySize = 4
    tx.requestCapturedSize = 3
    tx.responseCapturedSize = 4
    store.commit(tx)
    store.finalize(tx, 'complete')

    await store.toDetail(tx, { lazyBodyThreshold: 1024 })

    expect(tx.bodyViewCache?.request?.text).toBe('req')
    expect(tx.bodyViewCache?.response?.text).toBe('resp')
  })
})
