import type { AppSettings } from './types'

export const DEFAULT_SETTINGS: AppSettings = {
  proxyPort: 8888,
  autoStartProxy: true,
  allowLan: false,
  // 默认像 Charles 一样接管 Windows 系统代理，首次生效前会请求用户确认
  autoSystemProxy: true,
  systemProxyPrompted: false,
  // HTTPS 解密需要用户主动安装根证书，默认关闭
  decryptHttps: false,
  allowInsecureUpstream: false,
  upstreamProxyEnabled: false,
  upstreamProxyUrl: '',
  maxBodySize: 5 * 1024 * 1024,
  maxEntries: 3000,
  recordTunnels: true,
  // 默认保持浅色，用户可通过主界面工具栏的日/月图标切换
  theme: 'light'
}

export const APP_NAME = 'FakeCharles'
// 由构建配置从 package.json 注入，避免版本号维护两份
export const APP_VERSION = __APP_VERSION__

export const MIN_BODY_LIMIT = 64 * 1024
export const MAX_BODY_LIMIT = 50 * 1024 * 1024
export const MIN_ENTRIES = 100
export const MAX_ENTRIES = 20000
