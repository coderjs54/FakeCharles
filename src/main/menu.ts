import { dialog, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { APP_NAME, APP_VERSION } from '../shared/defaults'
import type { MainContext } from './context'

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
        { label: '开始 / 暂停记录', accelerator: 'CmdOrCtrl+Shift+R', click: () => ctx.sendCommand('toggle-recording') },
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
