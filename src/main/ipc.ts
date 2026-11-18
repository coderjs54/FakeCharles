import { app, clipboard, dialog, ipcMain, shell } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings, ComposePayload, EntryDetail } from '../shared/types'
import { IPC } from '../shared/types'
import { decodeBuffer } from './body'
import type { MainContext } from './context'
import { buildHar } from './har'
import { LAZY_BODY_THRESHOLD, type SessionFileData } from './session-store'

const SESSION_FILTERS = [
  { name: 'FakeCharles 会话', extensions: ['fchls', 'json'] },
  { name: '所有文件', extensions: ['*'] }
]

export function registerIpc(ctx: MainContext): void {
  ipcMain.handle(IPC.proxyStart, async (_event, port?: number) => {
    try {
      return await ctx.proxy.start(typeof port === 'number' ? port : undefined)
    } catch {
      // 具体错误已经通过 proxy 状态广播
      return ctx.proxy.getStatus()
    }
  })

  ipcMain.handle(IPC.proxyStop, async () => {
    await ctx.proxy.stop()
    return ctx.proxy.getStatus()
  })

  ipcMain.handle(IPC.proxyStatus, () => ctx.proxy.getStatus())

  ipcMain.handle(IPC.proxyRecording, (_event, recording: boolean) => ctx.proxy.setRecording(Boolean(recording)))

  ipcMain.handle(IPC.sessionList, () => ctx.store.list())

  ipcMain.handle(IPC.sessionClear, () => {
    ctx.store.clear()
  })

  ipcMain.handle(IPC.sessionRemove, (_event, id: string) => {
    ctx.store.remove(id)
  })

  ipcMain.handle(IPC.sessionEntry, async (_event, id: string, lazyBodies = false): Promise<EntryDetail | null> => {
    const tx = ctx.store.get(id)
    if (!tx) return null
    // 详情列表只需要元数据和小 Body；大 Body 由 sessionBody 按需拉取
    return ctx.store.toDetail(tx, lazyBodies ? { lazyBodyThreshold: LAZY_BODY_THRESHOLD } : undefined)
  })

  ipcMain.handle(IPC.sessionBody, async (_event, id: string, side: 'request' | 'response') => {
    return ctx.store.getBodyView(id, side === 'request' ? 'request' : 'response')
  })

  ipcMain.handle(IPC.sessionRepeat, (_event, id: string) => ctx.proxy.resend(id))

  ipcMain.handle(IPC.sessionCompose, (_event, payload: ComposePayload) => ctx.proxy.compose(payload))

  ipcMain.handle(IPC.settingsGet, () => ctx.settings.get())

  ipcMain.handle(IPC.systemProxyGet, () => ctx.systemProxy.getStatus())

  ipcMain.handle(IPC.httpsCaInfo, () => ctx.proxy.getHttpsCaInfo())

  ipcMain.handle(IPC.httpsCaEnsure, () => ctx.proxy.ensureHttpsCa())

  ipcMain.handle(IPC.httpsCaInstall, () => ctx.proxy.installHttpsCa())

  ipcMain.handle(IPC.httpsCaReveal, () => {
    const info = ctx.proxy.getHttpsCaInfo()
    if (info.certPath) shell.showItemInFolder(info.certPath)
    return info
  })

  ipcMain.handle(IPC.settingsUpdate, async (_event, payload: Partial<AppSettings>) => {
    const previous = ctx.settings.get()
    const patch: Partial<AppSettings> = { ...(payload ?? {}) }
    // 在设置页显式改动「自动系统代理」即视为已征求过同意
    if (
      patch.autoSystemProxy !== undefined &&
      patch.autoSystemProxy !== previous.autoSystemProxy
    ) {
      patch.systemProxyPrompted = true
    }
    const next = ctx.settings.update(patch)
    ctx.store.setMaxEntries(next.maxEntries)
    ctx.proxy.updateOptions({
      port: next.proxyPort,
      allowLan: next.allowLan,
      maxBodySize: next.maxBodySize,
      recordTunnels: next.recordTunnels,
      decryptHttps: next.decryptHttps,
      allowInsecureUpstream: next.allowInsecureUpstream,
      upstreamProxyUrl: next.upstreamProxyEnabled ? next.upstreamProxyUrl : ''
    })
    ctx.broadcast(IPC.eventSettings, next)
    const needRestart =
      ctx.proxy.getStatus().running && (previous.proxyPort !== next.proxyPort || previous.allowLan !== next.allowLan)
    if (needRestart) {
      try {
        await ctx.proxy.start()
      } catch {
        // 状态广播中已经包含错误信息
      }
    }
    // 处理「自动接管系统代理」开关变化；端口变化时也会在这里再次对齐
    ctx.syncSystemProxy()
    return next
  })

  ipcMain.handle(IPC.clipboardWrite, (_event, text: string) => {
    clipboard.writeText(String(text ?? ''))
  })

  ipcMain.handle(IPC.sessionSave, async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const result = await showSaveDialog(ctx, {
      title: '保存会话',
      defaultPath: join(app.getPath('documents'), `FakeCharles-${stamp}.fchls`),
      filters: SESSION_FILTERS
    })
    if (result.canceled || !result.filePath) return null
    const data = ctx.store.exportSession()
    writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf8')
    return { path: result.filePath, count: data.entries.length }
  })

  ipcMain.handle(IPC.sessionOpen, async () => {
    const result = await showOpenDialog(ctx, {
      title: '打开会话',
      properties: ['openFile'],
      filters: SESSION_FILTERS
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    let data: SessionFileData
    try {
      data = JSON.parse(readFileSync(filePath, 'utf8')) as SessionFileData
    } catch {
      throw new Error('会话文件解析失败，请确认文件内容完整')
    }
    const metas = ctx.store.importSession(data)
    ctx.broadcast(IPC.eventLoaded, metas)
    return { path: filePath, count: metas.length }
  })

  ipcMain.handle(IPC.sessionHar, async () => {
    const details: EntryDetail[] = []
    for (const meta of ctx.store.list()) {
      if (meta.tunnel || meta.method === 'CONNECT') continue
      const tx = ctx.store.get(meta.id)
      if (!tx) continue
      details.push(await ctx.store.toDetail(tx))
    }
    if (details.length === 0) throw new Error('当前会话没有可导出的 HTTP 请求')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const result = await showSaveDialog(ctx, {
      title: '导出 HAR',
      defaultPath: join(app.getPath('documents'), `FakeCharles-${stamp}.har`),
      filters: [{ name: 'HTTP Archive', extensions: ['har'] }]
    })
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, JSON.stringify(buildHar(details), null, 2), 'utf8')
    return { path: result.filePath, count: details.length }
  })

  ipcMain.handle(IPC.bodySave, async (_event, payload: { id: string; side: 'request' | 'response' }) => {
    const tx = ctx.store.get(payload?.id)
    if (!tx) throw new Error('请求已不存在')
    const side = payload.side === 'request' ? 'request' : 'response'
    const buffer = side === 'request'
      ? tx.requestBody ?? (tx.requestChunks.length ? Buffer.concat(tx.requestChunks) : null)
      : tx.responseBody ?? (tx.responseChunks.length ? Buffer.concat(tx.responseChunks) : null)
    if (!buffer || buffer.length === 0) throw new Error('当前没有可保存的内容')
    const encoding = side === 'request' ? tx.requestEncoding : tx.responseEncoding
    const decoded = await decodeBuffer(buffer, encoding)
    const mime = side === 'request' ? tx.meta.requestMime : tx.meta.responseMime
    const extension = extensionFromMime(mime)
    const suggested = fileNameFromUrl(tx.meta.url, extension, side)
    const result = await showSaveDialog(ctx, {
      title: '保存内容',
      defaultPath: join(app.getPath('downloads'), suggested)
    })
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, decoded.data)
    return { path: result.filePath, size: decoded.data.length }
  })
}

function showSaveDialog(
  ctx: MainContext,
  options: Electron.SaveDialogOptions
): Promise<Electron.SaveDialogReturnValue> {
  const win = ctx.getWindow()
  return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)
}

function showOpenDialog(
  ctx: MainContext,
  options: Electron.OpenDialogOptions
): Promise<Electron.OpenDialogReturnValue> {
  const win = ctx.getWindow()
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
}

function extensionFromMime(mime: string): string {
  const value = (mime || '').toLowerCase()
  if (value.includes('json')) return 'json'
  if (value.includes('html')) return 'html'
  if (value.includes('xml')) return 'xml'
  if (value.includes('css')) return 'css'
  if (value.includes('javascript')) return 'js'
  if (value.includes('csv')) return 'csv'
  if (value.includes('png')) return 'png'
  if (value.includes('jpeg') || value.includes('jpg')) return 'jpg'
  if (value.includes('gif')) return 'gif'
  if (value.includes('webp')) return 'webp'
  if (value.includes('svg')) return 'svg'
  if (value.includes('pdf')) return 'pdf'
  if (value.includes('zip')) return 'zip'
  if (value.includes('plain')) return 'txt'
  return 'bin'
}

function fileNameFromUrl(url: string, extension: string, side: 'request' | 'response'): string {
  let name = ''
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter(Boolean)
    name = segments[segments.length - 1] ?? ''
  } catch {
    // URL 解析失败时沿用空名称，由下方兜底生成文件名
  }
  name = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
  if (!name) name = side === 'request' ? 'request-body' : 'response-body'
  if (!name.toLowerCase().endsWith(`.${extension}`)) name = `${name}.${extension}`
  return name
}
