import { deflateRawSync, gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodeBuffer, renderBody } from './body'

describe('decodeBuffer', () => {
  it('正常解压 gzip 内容', async () => {
    const result = await decodeBuffer(gzipSync(Buffer.from('hello gzip')), 'gzip')

    expect(result.error).toBeUndefined()
    expect(result.data.toString()).toBe('hello gzip')
  })

  it('deflate 格式不匹配时回退到 raw deflate', async () => {
    const result = await decodeBuffer(deflateRawSync(Buffer.from('raw deflate')), 'deflate')

    expect(result.error).toBeUndefined()
    expect(result.data.toString()).toBe('raw deflate')
  })

  it('解压输出超过上限时返回友好错误并保留原始数据', async () => {
    const compressed = gzipSync(Buffer.alloc(1024 * 1024))
    const result = await decodeBuffer(compressed, 'gzip', 1024)

    expect(result.error).toContain('超过')
    expect(result.data.equals(compressed)).toBe(true)
  })
})

describe('renderBody', () => {
  it('文本内容按 MIME 解码', async () => {
    const result = await renderBody(
      Buffer.from('{"hello":"world"}'),
      17,
      false,
      'application/json; charset=utf-8'
    )

    expect(result.kind).toBe('text')
    expect(result.text).toContain('hello')
    expect(result.available).toBe(true)
  })

  it('二进制内容返回 base64', async () => {
    const data = Buffer.from([0, 1, 2, 3, 255])
    const result = await renderBody(data, data.length, false, 'application/octet-stream')

    expect(result.kind).toBe('binary')
    expect(result.base64).toBe(data.toString('base64'))
  })

  it('没有捕获到内容时给出提示', async () => {
    const result = await renderBody(null, 128, true, 'text/plain')

    expect(result.available).toBe(false)
    expect(result.kind).toBe('empty')
    expect(result.decodeError).toContain('未被捕获')
  })
})
