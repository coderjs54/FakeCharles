import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SystemProxyState } from '../shared/types'

/** Windows「Internet 选项」中的系统代理配置位置 */
export const INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

const VALUE_NAMES = ['ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL'] as const
type ValueName = (typeof VALUE_NAMES)[number]

export interface RegistryValue {
  type: string
  value: string
}

interface ProxyBackup {
  createdAt: number
  /** 我们接管时写入的地址，用于判断当前系统代理是否仍由本应用控制 */
  ourServer: string
  values: Partial<Record<ValueName, RegistryValue>>
}

export interface SystemProxyManagerOptions {
  /** 测试时可指向独立注册表键，避免改动真实系统代理 */
  registryKey?: string
  /** 测试时可关闭 InternetSetOption 通知 */
  notify?: boolean
}

/**
 * 自动接管 Windows 系统代理。
 * 启动代理时备份当前设置并指向 127.0.0.1:端口，停止代理或退出应用时恢复。
 * 备份文件在 userData 下，应用异常退出后下次启动会自动恢复。
 */
export class SystemProxyManager {
  private active = false
  private server = ''
  private lastError = ''
  private readonly registryKey: string
  private readonly notifyEnabled: boolean

  constructor(
    private readonly backupFile: string,
    options: SystemProxyManagerOptions = {}
  ) {
    this.registryKey = options.registryKey ?? INTERNET_SETTINGS_KEY
    this.notifyEnabled = options.notify !== false
  }

  get supported(): boolean {
    return process.platform === 'win32'
  }

  getStatus(): SystemProxyState {
    return {
      supported: this.supported,
      active: this.active,
      server: this.server,
      error: this.lastError || undefined
    }
  }

  /** 将系统代理指向本机代理端口；重复调用只会更新端口 */
  apply(port: number): SystemProxyState {
    if (!this.supported) return this.getStatus()
    const server = `127.0.0.1:${port}`
    this.lastError = ''

    try {
      if (this.active) {
        if (this.server !== server) {
          if (!writeRegistryValue(this.registryKey, 'ProxyEnable', 'REG_DWORD', '1')) {
            throw new Error('写入系统代理开关失败')
          }
          if (!writeRegistryValue(this.registryKey, 'ProxyServer', 'REG_SZ', server)) {
            throw new Error('写入系统代理地址失败')
          }
          this.notify()
          this.server = server
        }
        return this.getStatus()
      }

      // 处理上次异常退出留下的备份，避免把「已修改后的值」当成用户原值
      if (existsSync(this.backupFile)) {
        this.restore()
        if (existsSync(this.backupFile)) {
          throw new Error('上次的系统代理设置尚未恢复，已取消本次接管')
        }
      }

      const backup: ProxyBackup = {
        createdAt: Date.now(),
        ourServer: server,
        values: this.snapshot()
      }
      mkdirSync(dirname(this.backupFile), { recursive: true })
      writeFileSync(this.backupFile, JSON.stringify(backup, null, 2), 'utf8')

      if (!writeRegistryValue(this.registryKey, 'ProxyEnable', 'REG_DWORD', '1')) {
        throw new Error('写入系统代理开关失败')
      }
      if (!writeRegistryValue(this.registryKey, 'ProxyServer', 'REG_SZ', server)) {
        throw new Error('写入系统代理地址失败')
      }
      // PAC 脚本优先级高于手动代理，自动接管期间先移除
      deleteRegistryValue(this.registryKey, 'AutoConfigURL')

      this.notify()
      this.active = true
      this.server = server
    } catch (error) {
      this.lastError = `自动设置系统代理失败：${friendlyError(error)}`
      try {
        const backup = this.readBackup()
        if (backup) this.restoreBackup(backup)
      } catch {
        // 保留备份文件，下次启动继续尝试恢复
      }
      this.active = false
      this.server = ''
    }

    return this.getStatus()
  }

  /** 恢复接管前的系统代理设置 */
  restore(): SystemProxyState {
    if (!this.supported) return this.getStatus()
    this.lastError = ''

    try {
      if (!existsSync(this.backupFile)) {
        this.active = false
        this.server = ''
        return this.getStatus()
      }

      const backup = this.readBackup()
      if (!backup) {
        this.removeBackup()
        this.active = false
        this.server = ''
        return this.getStatus()
      }

      const expectedServer = this.server || backup.ourServer
      const currentEnabled = isProxyEnabled(readRegistryValue(this.registryKey, 'ProxyEnable'))
      const currentServer = readRegistryValue(this.registryKey, 'ProxyServer')?.value ?? ''

      // 用户在运行期间手动关闭或改掉了系统代理，不再用旧值覆盖
      if (!currentEnabled || currentServer !== expectedServer) {
        this.removeBackup()
        this.active = false
        this.server = ''
        return this.getStatus()
      }

      this.restoreBackup(backup)
      this.active = false
      this.server = ''
    } catch (error) {
      this.lastError = `恢复系统代理失败：${friendlyError(error)}`
    }

    return this.getStatus()
  }

  /** 应用启动时调用：如果上次是异常退出，则先把系统代理恢复为用户原值 */
  recover(): void {
    if (!this.supported || !existsSync(this.backupFile)) return

    try {
      const backup = this.readBackup()
      if (!backup) {
        this.removeBackup()
        return
      }

      const currentEnabled = isProxyEnabled(readRegistryValue(this.registryKey, 'ProxyEnable'))
      const currentServer = readRegistryValue(this.registryKey, 'ProxyServer')?.value ?? ''

      // 系统代理已被其他程序改过，不能贸然覆盖
      if (!currentEnabled || currentServer !== backup.ourServer) {
        this.removeBackup()
        return
      }

      this.restoreBackup(backup)
      console.log('[system-proxy] 已恢复上次异常退出时的系统代理设置')
    } catch (error) {
      console.error(`[system-proxy] 恢复上次系统代理失败：${friendlyError(error)}`)
    }
  }

  private snapshot(): Partial<Record<ValueName, RegistryValue>> {
    const values: Partial<Record<ValueName, RegistryValue>> = {}
    for (const name of VALUE_NAMES) {
      const value = readRegistryValue(this.registryKey, name)
      if (value) values[name] = value
    }
    return values
  }

  private readBackup(): ProxyBackup | null {
    try {
      const parsed = JSON.parse(readFileSync(this.backupFile, 'utf8')) as ProxyBackup
      if (!parsed || typeof parsed.ourServer !== 'string') return null
      return parsed
    } catch {
      return null
    }
  }

  private restoreBackup(backup: ProxyBackup): void {
    this.writeOrDelete('ProxyEnable', backup.values.ProxyEnable)
    this.writeOrDelete('ProxyServer', backup.values.ProxyServer)
    this.writeOrDelete('AutoConfigURL', backup.values.AutoConfigURL)
    this.notify()
    this.removeBackup()
    this.active = false
    this.server = ''
  }

  private writeOrDelete(name: ValueName, original?: RegistryValue): void {
    if (original) {
      if (!writeRegistryValue(this.registryKey, name, original.type, original.value)) {
        throw new Error(`恢复 ${name} 失败`)
      }
      return
    }
    deleteRegistryValue(this.registryKey, name)
  }

  private removeBackup(): void {
    try {
      rmSync(this.backupFile, { force: true })
    } catch {
      // ignore
    }
  }

  private notify(): void {
    if (!this.notifyEnabled) return
    notifySystemProxyChange()
  }
}

/** 通知 WinINet 刷新代理配置，让已打开的程序尽快读取新设置 */
export function notifySystemProxyChange(): boolean {
  if (process.platform !== 'win32') return false

  const script = [
    '$sig = \'[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);\'',
    'Add-Type -MemberDefinition $sig -Name FakeCharlesWinInet -Namespace FakeCharles',
    '[void][FakeCharles.FakeCharlesWinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)',
    '[void][FakeCharles.FakeCharlesWinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)'
  ].join('; ')

  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true, stdio: 'ignore', timeout: 20_000 }
    )
    return true
  } catch (error) {
    console.error(`[system-proxy] 通知系统刷新代理失败：${friendlyError(error)}`)
    return false
  }
}

/** 读取指定注册表值，不存在时返回 null */
export function readRegistryValue(key: string, name: string): RegistryValue | null {
  if (process.platform !== 'win32') return null
  const result = runReg(['query', key, '/v', name])
  if (!result.ok) return null

  const pattern = new RegExp(`^\\s+${escapeRegExp(name)}\\s+(REG_[A-Z0-9_]+)\\s*(.*)$`, 'im')
  const match = result.output.match(pattern)
  if (!match) return null
  return { type: match[1].toUpperCase(), value: match[2].trim() }
}

function writeRegistryValue(key: string, name: string, type: string, value: string): boolean {
  const normalized = normalizeRegistryValue(type, value)
  const result = runReg(['add', key, '/v', name, '/t', type, '/d', normalized, '/f'])
  if (!result.ok) {
    console.error(`[system-proxy] 写入 ${name} 失败：${result.output.trim()}`)
  }
  return result.ok
}

function deleteRegistryValue(key: string, name: string): boolean {
  const result = runReg(['delete', key, '/v', name, '/f'])
  return result.ok
}

function isProxyEnabled(value: RegistryValue | null): boolean {
  if (!value) return false
  const normalized = value.value.trim().toLowerCase()
  return normalized === '1' || normalized === '0x1'
}

function normalizeRegistryValue(type: string, value: string): string {
  if (type.toUpperCase() !== 'REG_DWORD') return value
  const parsed = value.trim().toLowerCase().startsWith('0x')
    ? Number.parseInt(value.trim().slice(2), 16)
    : Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? String(parsed) : '0'
}

function runReg(args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync('reg', args, {
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { ok: true, output }
  } catch (error) {
    const failure = error as { stdout?: string | Buffer; stderr?: string | Buffer }
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function friendlyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
