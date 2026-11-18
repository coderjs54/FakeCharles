import { describe, expect, it } from 'vitest'
import { parseUpstreamProxyUrl } from './upstream-proxy'

describe('parseUpstreamProxyUrl', () => {
  it('缺省协议按 http 处理并补全端口', () => {
    const result = parseUpstreamProxyUrl('proxy.company.com:8080')

    expect(result.error).toBeUndefined()
    expect(result.config).toMatchObject({
      protocol: 'http:',
      host: 'proxy.company.com',
      port: 8080
    })
  })

  it('解析用户名密码并生成 Proxy-Authorization', () => {
    const result = parseUpstreamProxyUrl('http://user:pass@proxy.company.com:3128')

    expect(result.error).toBeUndefined()
    expect(result.config?.authorization).toBe('Basic dXNlcjpwYXNz')
    expect(result.config?.host).toBe('proxy.company.com')
    expect(result.config?.port).toBe(3128)
  })

  it('支持 https 上游代理的默认端口', () => {
    const result = parseUpstreamProxyUrl('https://proxy.company.com')

    expect(result.error).toBeUndefined()
    expect(result.config?.protocol).toBe('https:')
    expect(result.config?.port).toBe(443)
  })

  it('拒绝不支持的协议', () => {
    const result = parseUpstreamProxyUrl('socks5://proxy.company.com:1080')

    expect(result.config).toBeUndefined()
    expect(result.error).toContain('仅支持 http / https')
  })

  it('空地址给出提示', () => {
    const result = parseUpstreamProxyUrl('   ')

    expect(result.config).toBeUndefined()
    expect(result.error).toContain('请填写')
  })
})
