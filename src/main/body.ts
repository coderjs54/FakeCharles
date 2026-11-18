import { brotliDecompress, gunzip, inflate, inflateRaw } from 'node:zlib'
import { promisify } from 'node:util'
import type { BodyView } from '../shared/types'

const gunzipAsync = promisify(gunzip) as unknown as AsyncDecode
const inflateAsync = promisify(inflate) as unknown as AsyncDecode
const inflateRawAsync = promisify(inflateRaw) as unknown as AsyncDecode
const brotliAsync = promisify(brotliDecompress) as unknown as AsyncDecode

/** 解压输出上限：防止压缩炸弹把主进程内存耗尽（捕获上限只限制压缩后字节） */
const MAX_DECODED_SIZE = 128 * 1024 * 1024

type AsyncDecode = (buffer: Buffer, options: { maxOutputLength: number }) => Promise<Buffer>

const MAX_DISPLAY_TEXT = 1_500_000
const MAX_DISPLAY_BINARY = 1_500_000

const BINARY_MIME_HINTS = [
  'image/',
  'audio/',
  'video/',
  'font/',
  'application/zip',
  'application/gzip',
  'application/pdf',
  'application/octet-stream',
  'application/wasm',
  'application/x-protobuf'
]

const TEXT_MIME_HINTS = [
  'text/',
  'json',
  'xml',
  'javascript',
  'ecmascript',
  'x-www-form-urlencoded',
  'graphql',
  'csv',
  'yaml',
  'xhtml',
  'svg'
]

export interface DecodedBuffer {
  data: Buffer
  error?: string
}

/** 按 Content-Encoding 解码响应体（gzip / deflate / br / zstd），并限制解压后的最大体积 */
export async function decodeBuffer(
  buffer: Buffer,
  contentEncoding?: string,
  maxOutputLength = MAX_DECODED_SIZE
): Promise<DecodedBuffer> {
  const encoding = (contentEncoding ?? '').toLowerCase().trim()
  if (!encoding || encoding === 'identity') return { data: buffer }
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') {
      return { data: await gunzipAsync(buffer, { maxOutputLength }) }
    }
    if (encoding === 'br') {
      return { data: await brotliAsync(buffer, { maxOutputLength }) }
    }
    if (encoding === 'deflate') {
      try {
        return { data: await inflateAsync(buffer, { maxOutputLength }) }
      } catch (error) {
        // 超过输出上限时直接失败，避免再尝试 raw deflate 造成二次解压
        if (isOutputLimitError(error)) throw error
        return { data: await inflateRawAsync(buffer, { maxOutputLength }) }
      }
    }
    const zlibModule = await import('node:zlib')
    const zstdDecompress = (zlibModule as unknown as { zstdDecompress?: ZstdDecompress }).zstdDecompress
    if (encoding === 'zstd' && typeof zstdDecompress === 'function') {
      const data = await new Promise<Buffer>((resolve, reject) => {
        zstdDecompress(buffer, { maxOutputLength }, (err, out) => (err ? reject(err) : resolve(out)))
      })
      return { data }
    }
  } catch (error) {
    const message = isOutputLimitError(error)
      ? `内容解压后超过 ${maxOutputLength / 1024 / 1024} MB 上限，已停止解码`
      : `内容解码失败：${(error as Error).message}`
    return { data: buffer, error: message }
  }
  return { data: buffer }
}

type ZstdDecompress = (
  input: Buffer,
  options: { maxOutputLength: number },
  callback: (error: Error | null, output: Buffer) => void
) => void

/** Node zlib 在解压输出超过 maxOutputLength 时抛出的错误码 */
function isOutputLimitError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ERR_BUFFER_TOO_LARGE'
}

/** 将捕获到的字节转换为渲染进程可直接展示的 BodyView */
export async function renderBody(
  buffer: Buffer | null,
  transferredSize: number,
  truncated: boolean,
  mime: string,
  contentEncoding?: string
): Promise<BodyView> {
  const base: BodyView = {
    available: false,
    size: transferredSize,
    capturedSize: buffer?.length ?? 0,
    decodedSize: 0,
    truncated,
    textTruncated: false,
    kind: 'empty',
    mime: mime || '',
    encoding: contentEncoding || undefined
  }
  if (!buffer || buffer.length === 0) {
    if (transferredSize > 0) base.decodeError = '响应体未被捕获（可能被大小限制丢弃）'
    return base
  }

  const decoded = await decodeBuffer(buffer, contentEncoding)
  const data = decoded.data
  const textLike = isTextMime(mime) || (!isBinaryMime(mime) && looksLikeText(data))

  base.available = true
  base.decodedSize = data.length
  base.decodeError = decoded.error

  if (!textLike || decoded.error) {
    const slice = data.subarray(0, MAX_DISPLAY_BINARY)
    base.kind = 'binary'
    base.base64 = slice.toString('base64')
    base.textTruncated = data.length > slice.length
    return base
  }

  const charset = parseCharset(mime)
  let text = decodeText(data, charset)
  if (text.length > MAX_DISPLAY_TEXT) {
    text = text.slice(0, MAX_DISPLAY_TEXT)
    base.textTruncated = true
  }
  base.kind = 'text'
  base.text = text
  return base
}

export function isTextMime(mime: string): boolean {
  const value = mime.toLowerCase()
  if (!value) return false
  if (BINARY_MIME_HINTS.some((hint) => value.includes(hint))) return false
  return TEXT_MIME_HINTS.some((hint) => value.includes(hint))
}

export function isBinaryMime(mime: string): boolean {
  const value = mime.toLowerCase()
  return BINARY_MIME_HINTS.some((hint) => value.includes(hint))
}

function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 2048)
  if (sample.length === 0) return true
  let control = 0
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue
    if (byte < 32 || byte === 127) control += 1
  }
  return control / sample.length < 0.02
}

function parseCharset(mime: string): string {
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(mime)
  return match?.[1]?.trim() || 'utf-8'
}

function decodeText(buffer: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  }
}
