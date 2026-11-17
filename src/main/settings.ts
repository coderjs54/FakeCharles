import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_SETTINGS, MAX_BODY_LIMIT, MAX_ENTRIES, MIN_BODY_LIMIT, MIN_ENTRIES } from '../shared/defaults'
import type { AppSettings } from '../shared/types'

/** 简单的 settings.json 持久化，带字段校验与范围钳制 */
export class SettingsStore {
  private settings: AppSettings

  constructor(private readonly filePath: string) {
    this.settings = this.load()
  }

  get(): AppSettings {
    return { ...this.settings }
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.settings = normalize({ ...this.settings, ...patch })
    this.save()
    return this.get()
  }

  private load(): AppSettings {
    try {
      if (!existsSync(this.filePath)) return { ...DEFAULT_SETTINGS }
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<AppSettings>
      return normalize({ ...DEFAULT_SETTINGS, ...raw })
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2), 'utf8')
    } catch {
      // 配置写入失败不影响主流程
    }
  }
}

function normalize(input: Partial<AppSettings>): AppSettings {
  const port = Number(input.proxyPort)
  const bodySize = Number(input.maxBodySize)
  const maxEntries = Number(input.maxEntries)
  return {
    proxyPort: Number.isFinite(port) ? clamp(Math.round(port), 1024, 65535) : DEFAULT_SETTINGS.proxyPort,
    autoStartProxy: Boolean(input.autoStartProxy),
    allowLan: Boolean(input.allowLan),
    autoSystemProxy: input.autoSystemProxy !== false,
    decryptHttps: input.decryptHttps === true,
    allowInsecureUpstream: input.allowInsecureUpstream === true,
    maxBodySize: Number.isFinite(bodySize) ? clamp(Math.round(bodySize), MIN_BODY_LIMIT, MAX_BODY_LIMIT) : DEFAULT_SETTINGS.maxBodySize,
    maxEntries: Number.isFinite(maxEntries) ? clamp(Math.round(maxEntries), MIN_ENTRIES, MAX_ENTRIES) : DEFAULT_SETTINGS.maxEntries,
    recordTunnels: input.recordTunnels !== false
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
