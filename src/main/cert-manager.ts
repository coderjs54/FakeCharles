import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import forge from 'node-forge'
import type { HttpsCaInfo } from '../shared/types'

export interface LeafCertificate {
  key: string
  cert: string
}

interface KeyPairPem {
  privateKey: string
  publicKey: string
}

/**
 * 本地 HTTPS 解密 CA。
 * - 首次使用时生成一张本地根证书，保存在 userData 下
 * - 为每个目标域名动态签发叶子证书
 * - 根证书私钥只保存在本地，不会发送给渲染进程
 */
export class CertificateAuthority {
  private readonly caCertPath: string
  private readonly caKeyPath: string
  private caCertPem = ''
  private caCert: forge.pki.Certificate | null = null
  private caPrivateKey: forge.pki.rsa.PrivateKey | null = null
  private leafPrivateKeyPem = ''
  private leafPublicKey: forge.pki.PublicKey | null = null
  private readonly certCache = new Map<string, LeafCertificate>()
  private lastError = ''
  private loaded = false

  constructor(private readonly baseDir: string) {
    this.caCertPath = join(baseDir, 'fakecharles-ca.crt')
    this.caKeyPath = join(baseDir, 'fakecharles-ca.key')
  }

  get certPath(): string {
    return this.caCertPath
  }

  get supported(): boolean {
    // 证书生成和 TLS MITM 本身跨平台可用；
    // 是否支持一键安装到系统信任存储由 installable 表示。
    return true
  }

  get installable(): boolean {
    return process.platform === 'win32'
  }

  getInfo(): HttpsCaInfo {
    const generated = existsSync(this.caCertPath) && existsSync(this.caKeyPath)
    let certPem: string | undefined
    if (generated) {
      try {
        certPem = readFileSync(this.caCertPath, 'utf8')
      } catch {
        certPem = undefined
      }
    }

    return {
      supported: this.supported,
      installable: this.installable,
      generated,
      certPath: generated ? this.caCertPath : undefined,
      certPem,
      platform: process.platform,
      message: this.describeMessage(generated),
      error: this.lastError || undefined
    }
  }

  /** 加载已有 CA；不存在时生成新的根证书 */
  ensure(): HttpsCaInfo {
    try {
      this.loadOrGenerate()
      this.lastError = ''
    } catch (error) {
      this.lastError = friendlyError(error)
    }
    return this.getInfo()
  }

  /** 获取指定域名的动态证书，内部会缓存 */
  getCertificate(host: string): LeafCertificate {
    const normalizedHost = normalizeHost(host)
    const cached = this.certCache.get(normalizedHost)
    if (cached) return cached

    this.loadOrGenerate()
    const caCert = this.caCert
    const caKey = this.caPrivateKey
    const leafPublicKey = this.leafPublicKey
    if (!caCert || !caKey || !leafPublicKey || !this.leafPrivateKeyPem) {
      throw new Error('本地 HTTPS 根证书尚未准备完成')
    }

    const cert = forge.pki.createCertificate()
    cert.publicKey = leafPublicKey
    cert.serialNumber = newSerialNumber()
    cert.validity.notBefore = new Date(Date.now() - 5 * 60 * 1000)
    cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)

    const commonName = normalizedHost.length > 64 ? normalizedHost.slice(0, 64) : normalizedHost
    cert.setSubject([{ name: 'commonName', value: commonName }])
    cert.setIssuer(caCert.subject.attributes)

    const ipVersion = isIP(normalizedHost)
    const altNames =
      ipVersion === 0
        ? [{ type: 2, value: normalizedHost }]
        : [{ type: 7, ip: normalizedHost }]

    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames }
    ])
    cert.sign(caKey, forge.md.sha256.create())

    const leaf: LeafCertificate = {
      key: this.leafPrivateKeyPem,
      cert: forge.pki.certificateToPem(cert)
    }

    // 避免长时间运行后缓存无限增长
    if (this.certCache.size > 1000) this.certCache.clear()
    this.certCache.set(normalizedHost, leaf)
    return leaf
  }

  getCaPem(): string {
    this.loadOrGenerate()
    return this.caCertPem
  }

  /** 将根证书安装到 Windows 当前用户的 Root 证书存储 */
  install(): HttpsCaInfo {
    const info = this.ensure()
    if (!info.generated) return info

    if (!this.installable) {
      return {
        ...info,
        message: '当前平台需要手动安装证书。已生成证书文件，请将它导入浏览器或系统信任存储。'
      }
    }

    try {
      execFileSync('certutil', ['-user', '-addstore', '-f', 'Root', this.caCertPath], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 20_000
      })
      this.lastError = ''
      return {
        ...this.getInfo(),
        message: '根证书已安装到当前用户 Root 证书存储；如果浏览器仍报错，请重启浏览器。'
      }
    } catch (error) {
      this.lastError = `安装根证书失败：${friendlyError(error)}`
      return this.getInfo()
    }
  }

  private loadOrGenerate(): void {
    if (this.loaded) return
    mkdirSync(this.baseDir, { recursive: true })

    if (existsSync(this.caCertPath) && existsSync(this.caKeyPath)) {
      try {
        this.load()
        return
      } catch (error) {
        // 文件损坏时重新生成；旧证书信任需要用户重新安装
        this.lastError = `已有根证书读取失败，将重新生成：${friendlyError(error)}`
      }
    }

    this.generate()
  }

  private load(): void {
    const certPem = readFileSync(this.caCertPath, 'utf8')
    const keyPem = readFileSync(this.caKeyPath, 'utf8')
    const caCert = forge.pki.certificateFromPem(certPem)
    const caKey = forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey

    this.caCertPem = certPem
    this.caCert = caCert
    this.caPrivateKey = caKey
    this.ensureLeafKey()
    this.loaded = true
  }

  private generate(): void {
    const caKeys = generateKeyPair()
    const caPublicKey = forge.pki.publicKeyFromPem(caKeys.publicKey)
    const caPrivateKey = forge.pki.privateKeyFromPem(caKeys.privateKey) as forge.pki.rsa.PrivateKey

    const cert = forge.pki.createCertificate()
    cert.publicKey = caPublicKey
    cert.serialNumber = newSerialNumber()
    cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000)
    cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000)

    const subject = [
      { name: 'commonName', value: 'FakeCharles Local CA' },
      { name: 'organizationName', value: 'FakeCharles' },
      { name: 'organizationalUnitName', value: 'Local HTTPS Debugging' }
    ]
    cert.setSubject(subject)
    cert.setIssuer(subject)
    cert.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
      { name: 'subjectKeyIdentifier' }
    ])
    cert.sign(caPrivateKey, forge.md.sha256.create())

    const caCertPem = forge.pki.certificateToPem(cert)
    // 私钥只写入 userData 目录：POSIX 下使用 0600；Windows 依赖用户配置目录继承的 ACL
    writeFileSync(this.caCertPath, caCertPem, { encoding: 'utf8', mode: 0o600 })
    writeFileSync(this.caKeyPath, caKeys.privateKey, { encoding: 'utf8', mode: 0o600 })

    this.caCertPem = caCertPem
    this.caCert = cert
    this.caPrivateKey = caPrivateKey
    this.ensureLeafKey()
    this.loaded = true
  }

  private ensureLeafKey(): void {
    if (this.leafPrivateKeyPem && this.leafPublicKey) return
    const keys = generateKeyPair()
    this.leafPrivateKeyPem = keys.privateKey
    this.leafPublicKey = forge.pki.publicKeyFromPem(keys.publicKey)
  }

  private describeMessage(generated: boolean): string {
    if (!generated) return '尚未生成 HTTPS 解密根证书'
    if (!this.installable) {
      return '根证书已生成，请手动把它安装到浏览器或系统信任存储'
    }
    return '可安装到 Windows 当前用户 Root 证书存储'
  }
}

function generateKeyPair(): KeyPairPem {
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  })
  return { privateKey: keys.privateKey, publicKey: keys.publicKey }
}

function newSerialNumber(): string {
  return randomBytes(16).toString('hex')
}

function normalizeHost(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase()
}

function friendlyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
