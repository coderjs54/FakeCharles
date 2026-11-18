export interface UpstreamProxyConfig {
  /** 规范化后的代理地址（可能包含凭据，仅供主进程使用） */
  url: string
  protocol: 'http:' | 'https:'
  /** 不含 IPv6 方括号的主机名 */
  host: string
  port: number
  /** 手写 CONNECT / 绝对形式请求时使用的 Proxy-Authorization */
  authorization?: string
}

export interface UpstreamProxyParseResult {
  config?: UpstreamProxyConfig
  error?: string
}

/**
 * 解析并校验上游代理地址。
 * 缺省协议按 http 处理，支持 http://user:pass@host:port 形式。
 */
export function parseUpstreamProxyUrl(raw: string): UpstreamProxyParseResult {
  const value = (raw ?? '').trim()
  if (!value) return { error: '请填写上游代理地址' }

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`
  let url: URL
  try {
    url = new URL(withProtocol)
  } catch {
    return { error: '上游代理地址格式不正确' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: '上游代理仅支持 http / https 地址' }
  }
  if (!url.hostname) return { error: '上游代理地址缺少主机名' }

  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: '上游代理端口不正确' }
  }

  return {
    config: {
      url: url.toString(),
      protocol: url.protocol,
      host: url.hostname.replace(/^\[/, '').replace(/\]$/, ''),
      port,
      authorization: buildAuthorization(url)
    }
  }
}

function buildAuthorization(url: URL): string | undefined {
  if (!url.username && !url.password) return undefined
  const credentials = `${safeDecode(url.username)}:${safeDecode(url.password)}`
  return `Basic ${base64(credentials)}`
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** 在渲染进程和主进程中都可用，避免依赖 Node Buffer */
function base64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary)
}
