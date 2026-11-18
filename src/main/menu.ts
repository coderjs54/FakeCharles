import { dialog, Menu, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { APP_NAME, APP_VERSION } from '../shared/defaults'
import type { AppSettings } from '../shared/types'
import type { MainContext } from './context'
import { getLogDirectory, readRecentLogs } from './logger'

/** 隐藏上游代理地址中的密码，避免导出诊断时泄漏凭据 */
function redactSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    upstreamProxyUrl: settings.upstreamProxyUrl.replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:***@')
  }
}

/** 导出包含版本、代理状态、设置与最近日志的诊断文本，便于用户反馈问题 */
async function exportDiagnostics(ctx: MainContext): Promise<void> {
  const win = ctx.getWindow()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const saveOptions = {
    title: '导出诊断信息',
    defaultPath: `fakecharles-diagnostics-${stamp}.txt`,
    filters: [{ name: '文本文件', extensions: ['txt'] }]
  }
  const result = win ? await dialog.showSaveDialog(win, saveOptions) : await dialog.showSaveDialog(saveOptions)
  if (result.canceled || !result.filePath) return

  const content = [
    `${APP_NAME} ${APP_VERSION} 诊断信息`,
    `导出时间: ${new Date().toISOString()}`,
    `系统: ${process.platform} ${process.arch} (${release()})`,
    `Electron: ${process.versions.electron}`,
    `Chromium: ${process.versions.chrome}`,
    `Node: ${process.versions.node}`,
    `日志目录: ${getLogDirectory()}`,
    '',
    '== 代理状态 ==',
    JSON.stringify(ctx.proxy.getStatus(), null, 2),
    '',
    '== 当前设置 ==',
    JSON.stringify(redactSettings(ctx.settings.get()), null, 2),
    '',
    '== 最近日志 ==',
    readRecentLogs() || '(暂无日志)'
  ].join('\n')

  try {
    writeFileSync(result.filePath, content, 'utf8')
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: '导出诊断信息',
      message: '导出失败',
      detail: error instanceof Error ? error.message : String(error)
    })
    return
  }

  await dialog.showMessageBox({
    type: 'info',
    title: '导出诊断信息',
    message: '诊断信息已导出',
    detail: result.filePath
  })
}

/** 构建与 Charles 类似的桌面菜单 */
export function installApplicationMenu(ctx: MainContext): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '新建请求…', accelerator: 'CmdOrCtrl+N', click: () => ctx.sendCommand('compose') },
        { type: 'separator' },
        { label: '打开会话…', accelerator: 'CmdOrCtrl+O', click: () => ctx.sendCommand('open-session') },
        { label: '保存会话…', accelerator: 'CmdOrCtrl+S', click: () => ctx.sendCommand('save-session') },
        { label: '导出 HAR…', accelerator: 'CmdOrCtrl+Shift+E', click: () => ctx.sendCommand('export-har') },
        { type: 'separator' },
        { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => ctx.sendCommand('open-settings') },
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' }
      ]
    },
    {
      label: '会话',
      submenu: [
        { label: '清空会话', accelerator: 'CmdOrCtrl+K', click: () => ctx.sendCommand('clear-session') },
        { type: 'separator' },
        {
          label: '开始 / 暂停记录',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => ctx.sendCommand('toggle-recording')
        },
        { label: '查找请求', accelerator: 'CmdOrCtrl+F', click: () => ctx.sendCommand('focus-filter') }
      ]
    },
    {
      label: '代理',
      submenu: [
        { label: '启动 / 停止代理', accelerator: 'CmdOrCtrl+Shift+P', click: () => ctx.sendCommand('toggle-proxy') },
        { label: '复制代理地址', click: () => ctx.sendCommand('copy-proxy') },
        { type: 'separator' },
        { label: '代理设置…', click: () => ctx.sendCommand('open-settings') }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开日志目录',
          click: () => {
            void shell.openPath(getLogDirectory())
          }
        },
        {
          label: '导出诊断信息…',
          click: () => {
            void exportDiagnostics(ctx)
          }
        },
        { type: 'separator' },
        {
          label: `关于 ${APP_NAME}`,
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: `关于 ${APP_NAME}`,
              message: `${APP_NAME} ${APP_VERSION}`,
              detail:
                '一个 Charles 风格的桌面 HTTP 抓包代理。\n\n' +
                '· 支持 HTTP 抓包，并可通过本地 CA 解密 HTTPS（需安装并信任根证书）\n' +
                '· 支持 Structure / Sequence 视图、请求重放、Compose（cURL / HTTPS）、会话保存与 HAR 导出\n\n' +
                `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`
            })
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
