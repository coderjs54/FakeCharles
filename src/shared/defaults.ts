import type { AppSettings } from './types'

export const DEFAULT_SETTINGS: AppSettings = {
  proxyPort: 8888,
  autoStartProxy: true,
  allowLan: false,
  // 默认像 Charles 一样接管 Windows 系统代理，关闭窗口时恢复
  autoSystemProxy: true,
  // HTTPS 解密需要用户主动安装根证书，默认关闭
  decryptHttps: false,
  allowInsecureUpstream: false,
  maxBodySize: 5 * 1024 * 1024,
  maxEntries: 3000,
  recordTunnels: true
}

export const APP_NAME = 'FakeCharles'
export const APP_VERSION = '1.0.0'

export const MIN_BODY_LIMIT = 64 * 1024
export const MAX_BODY_LIMIT = 50 * 1024 * 1024
export const MIN_ENTRIES = 100
export const MAX_ENTRIES = 20000
