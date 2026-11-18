<p align="center">
  <img src="resources/icon.png" width="88" alt="FakeCharles icon" />
</p>

<h1 align="center">FakeCharles</h1>

<p align="center">Charles 风格的 HTTP / HTTPS 抓包代理桌面应用</p>

<p align="center">Electron + Vue 3 + TypeScript + SCSS + pnpm</p>

FakeCharles 是一个面向开发调试的 HTTP/HTTPS 抓包工具。它在本机启动代理，实时展示浏览器或系统中的请求，并提供类似 Charles 的请求列表、详情查看、重放、会话保存和 HAR 导出能力。

默认只抓取 HTTP 明文请求。你可以在设置中开启 **HTTPS 解密**，通过本地 CA 做 TLS 中间人解密；该功能默认关闭，开启前需要生成并信任本地根证书。

## 功能

- HTTP 代理转发与实时抓包，默认监听 `127.0.0.1:8888`
- 可选的 HTTPS 解密（TLS MITM）：本地 CA 动态签发域名证书
- Windows 一键安装根证书；其他平台可打开证书位置手动信任
- `Structure` 树形视图与 `Sequence` 时序视图
- URL、方法、状态码文本过滤，以及 HTTPS 请求显示/隐藏开关
- 浅色 / 暗黑主题切换：工具栏右侧日/月图标一键切换，选择会持久保存
- 请求详情：Overview、Timing、Headers、Query、Cookies、Body、Raw
- gzip / deflate / br / zstd 解码，JSON 格式化高亮
- HTML 沙箱预览、图片预览、二进制 Hex 查看
- 复制 URL、复制为 cURL、保存请求/响应体
- 请求重放（含解密后的 HTTPS）、Compose 手动构造请求（支持粘贴 cURL 与 HTTPS 地址）、右键菜单操作
- 支持通过上游 HTTP / HTTPS 代理转发（企业网络场景）
- 支持 HTTPS 解密后的 WebSocket / Upgrade 透传（不解析帧）
- 会话保存/加载（`.fchls`）、HAR 导出
- 暂停/恢复记录、清空会话、停止/重启代理
- Windows 下自动接管系统代理，退出或停止代理时恢复原设置；异常退出后下次启动自动恢复
- 端口、局域网访问、Body 上限、会话条目数等设置持久化
- 内置端到端自测，覆盖代理转发、HTTPS MITM、会话、UI 和系统代理逻辑

## 界面截图

> 以下截图由项目内置的端到端自测自动生成，使用本地测试数据。

<p align="center">
  <img src="docs/images/main.png" alt="FakeCharles 主界面：请求列表与响应详情" width="100%" />
</p>

| Overview 与耗时 | Sequence 时序列表 |
| :---: | :---: |
| ![Overview](docs/images/overview.png) | ![Sequence](docs/images/sequence.png) |
| **代理设置** | **Compose 新建请求** |
| ![代理设置](docs/images/settings.png) | ![Compose](docs/images/compose.png) |
| **请求右键菜单** | **隐藏 HTTPS 请求** |
| ![右键菜单](docs/images/context-menu.png) | ![HTTPS 过滤](docs/images/https-filter.png) |

<p align="center">
  <img src="docs/images/https-detail.png" alt="HTTPS 解密后的请求与响应详情" width="100%" />
</p>

> 开启 HTTPS 解密并信任根证书后，HTTPS 请求会像 HTTP 一样显示 Request、Headers、Body 和 Response 内容。

## 技术栈

- Electron 45
- electron-vite 6
- Vue 3.5 + TypeScript
- SCSS
- pnpm 11
- electron-builder 26（Windows NSIS 安装包与 Linux AppImage 配置）
- node-forge（本地 CA 与动态证书生成）

## 快速开始

### 环境要求

- Node.js 22+
- pnpm 11+
- Windows 10/11（自动系统代理功能仅 Windows 可用；其他平台仍可手动配置代理）

```bash
pnpm install
pnpm dev
```

生产构建与预览：

```bash
pnpm build
pnpm start
```

## 使用

1. 启动应用后，代理默认监听 `127.0.0.1:8888`，并在启动时自动开启。
2. Windows 下默认自动接管系统代理（首次启动会先询问是否允许），底部状态栏会显示“系统代理已接管”。Chrome、Edge 等遵循系统代理的应用无需额外配置。
3. 浏览器访问一个 **HTTP** 地址，例如：

    ```text
    http://neverssl.com
    ```

4. 请求会实时出现在左侧列表，点击即可查看请求头、响应头、Body 和耗时。
5. 关闭应用或停止代理时，会恢复原来的系统代理设置。

如果 8888 端口被 Charles 或其他代理工具占用，应用顶部会显示错误提示。此时请退出占用程序，或在“代理设置”中更换端口。

### 手动配置代理

如果关闭了“自动设置 Windows 系统代理”，或在非 Windows 平台运行，可以手动将浏览器/系统的 HTTP 代理指向：

```text
127.0.0.1:8888
```

使用 `curl` 验证代理是否工作：

```powershell
curl.exe -x http://127.0.0.1:8888 http://neverssl.com
```

Firefox 等拥有独立代理设置的应用，需要在应用内部单独配置。未开启 HTTPS 解密时，HTTPS 请求只会显示 CONNECT 隧道提示。

### 通过公司上游代理上网（可选）

如果所在网络要求先经过公司 HTTP 代理，打开“代理设置 → 上游代理”，开启并填写：

```text
http://proxy.company.com:8080
```

支持 `http://` / `https://` 以及 `http://user:pass@host:port` 形式。用户名密码会以明文保存在本机设置文件中。

### 抓取 HTTPS 内容（可选）

1. 打开“代理设置 → 捕获行为”，开启 **解密 HTTPS 内容**。
2. 在“HTTPS 解密根证书”卡片中点击 **生成根证书**。
3. 点击 **安装/信任根证书**：
   - Windows：安装到当前用户的 Root 证书存储，无需管理员权限
   - macOS/Linux：点击“打开证书位置”，手动导入系统或浏览器的信任存储
4. 保存设置并重启浏览器。
5. 访问任意 HTTPS 页面，请求会像 HTTP 一样出现在列表中。

注意事项：

- 根证书私钥只保存在本机 userData 目录，不会发送给渲染进程（POSIX 下文件权限为 0600，Windows 依赖用户配置目录的 ACL）
- Firefox 使用独立证书存储，需要单独导入根证书
- 当前 HTTPS 解密强制使用 HTTP/1.1，不支持完整 HTTP/2 / HTTP/3 透传
- 使用证书固定（certificate pinning）或双向证书（mTLS）的应用可能无法解密
- 仅在你拥有或获得授权的设备和流量上使用；调试结束后建议移除根证书信任

如果请求详情里出现：

```text
self signed certificate; if the root CA is installed locally, try running Node.js with --use-system-ca
```

说明是**代理到上游服务器的证书校验失败**，不是浏览器不信任本地根证书。对于自签名或内部 CA 的上游站点，可以：

- 打开“忽略上游 HTTPS 证书错误”后再试（不校验上游证书，存在风险）
- 或者通过 `NODE_EXTRA_CA_CERTS` 为 Node 提供上游 CA（需要另外管理证书）

## 代理设置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| 代理端口 | `8888` | 修改后自动重启代理 |
| 启动时自动开启代理 | 开启 | 应用启动后立即监听端口 |
| 允许局域网设备连接 | 关闭 | 开启后绑定 `0.0.0.0`；代理无认证，仅限可信网络 |
| 自动设置 Windows 系统代理 | 开启 | 接管并在退出时恢复系统代理；首次生效前会请求确认 |
| 解密 HTTPS 内容 | 关闭 | 使用本地 CA 做 TLS 中间人解密 |
| 忽略上游 HTTPS 证书错误 | 关闭 | 仅用于自签名/内部上游证书站点，存在安全风险 |
| 通过上游代理转发 | 关闭 | 企业网络需要先经过公司代理时开启 |
| 上游代理地址 | 空 | 支持 `http://` / `https://` 与 `user:pass@host:port` |
| 记录未解密的 HTTPS 隧道 | 开启 | 解密关闭时为 CONNECT 连接生成提示 |
| 单个 Body 上限 | 5 MB | 超出部分截断 |
| 会话最大条目数 | 3000 | 超出后丢弃最早记录 |

> 除条目数限制外，会话内容还有约 256 MB 的内存预算；超出后会优先淘汰最旧记录，避免长时间抓包或大 Body 耗尽内存。

> 上游代理地址中的用户名密码会以明文形式保存在本机设置文件中，请仅在受控设备上使用。

## 日志与诊断

主进程会把启动、代理启停、系统代理操作和运行期错误写入 userData 下的 `logs/main.log`；单个文件超过 2 MB 时会轮转为 `main.1.log`。

- **帮助 → 打开日志目录**：直接打开日志所在文件夹
- **帮助 → 导出诊断信息…**：生成包含版本、系统信息、代理状态、设置和最近日志的文本文件；上游代理地址中的密码会被替换为 `***`

## 可用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 启动开发模式和 Electron 窗口 |
| `pnpm build` | 类型检查 + 构建主进程、预加载和渲染进程 |
| `pnpm start` | 预览已构建的应用 |
| `pnpm typecheck` | 执行 TypeScript / Vue 类型检查 |
| `pnpm lint` | 运行 ESLint 静态检查 |
| `pnpm lint:fix` | 自动修复可修复的 ESLint 问题 |
| `pnpm format` | 使用 Prettier 格式化代码 |
| `pnpm test` | 运行 Vitest 单元测试 |
| `pnpm test:watch` | 以监听模式运行单元测试 |
| `pnpm selftest` | 构建并运行端到端自测，生成截图与结果文件 |
| `pnpm dist` | 构建当前平台的分发包 |
| `pnpm dist:win` | 生成 Windows NSIS 安装包 |
| `pnpm dist:linux` | 生成 Linux AppImage 分发包 |
| `pnpm dist:dir` | 生成未压缩的打包目录，便于快速验证 |

### 打包 Windows 安装包

```bash
pnpm dist:win
```

产物位于：

```text
release/FakeCharles-Setup-1.0.0-x64.exe
release/win-unpacked/FakeCharles.exe
```

安装包支持选择安装目录，并创建桌面和开始菜单快捷方式。当前产物未配置代码签名，正式分发时建议配置 Windows 代码签名证书。

### 打包 Linux AppImage

在 Linux 环境中执行：

```bash
pnpm dist:linux
```

产物位于：

```text
release/FakeCharles-1.0.0.AppImage
```

AppImage 未做代码签名；首次运行前需要执行 `chmod +x`，部分发行版还需要安装 `libfuse2` 才能直接挂载运行。

## 持续集成

GitHub Actions 工作流位于 `.github/workflows/ci.yml`，在以下场景触发：

- push 到 `main`
- Pull Request
- 推送 `v*` 标签
- 手动触发

CI 会并行执行两个任务：

- `windows-latest`：ESLint、类型检查与构建、单元测试、Electron 自测、打包 NSIS 安装包，并上传自测报告与截图
- `ubuntu-latest`：类型检查与构建、单元测试、打包 AppImage

推送 `v*` 标签时，只有两个任务都成功才会创建 GitHub Release。

### 发布新版本

更新 `package.json` 中的版本号并提交后，推送同名标签：

```bash
git tag v1.0.0
git push origin v1.0.0
```

应用内显示和安装包使用的版本号都由 `package.json` 在构建时注入，无需同步修改其他源码文件。

标签构建通过测试并成功生成安装包后，会自动创建 GitHub Release，并附上：

```text
FakeCharles-Setup-<version>-x64.exe
FakeCharles-<version>.AppImage
```

注意：标签名必须与 `package.json` 的 `version` 一致，否则 CI 会在构建前失败。普通的 `main` push 和 PR 只运行测试与构建，不会创建 Release。

## 项目结构

```text
src/
├─ main/                  Electron 主进程：代理、会话、IPC、系统代理、HTTPS CA、日志
├─ preload/               preload 桥接 API
├─ renderer/              Vue 3 渲染进程
│  └─ src/
│     ├─ components/      列表、详情、对话框、工具栏等组件
│     ├─ stores/          会话与提示状态
│     └─ utils/           格式化、JSON 高亮、cURL、结构树工具
└─ shared/                主进程与渲染进程共享类型
resources/                应用图标
docs/images/              README 截图
.github/workflows/        GitHub Actions
electron-builder.yml      打包配置
```

## 已知限制

- HTTPS 解密默认关闭，需要生成并信任本地根证书
- HTTPS 解密当前强制 HTTP/1.1，未完整支持 HTTP/2 / HTTP/3
- WebSocket / Upgrade 仅透传字节流，不解析帧，也不支持 HTTP/2 WebSocket
- 上游 HTTPS 证书校验使用 Node 的默认 CA 存储；企业私有 CA 或自签名上游需要开启“忽略上游 HTTPS 证书错误”或额外配置 CA
- 证书固定（certificate pinning）、mTLS、部分移动 App 和独立信任库应用可能无法解密
- 未实现 Charles 的断点、Rewrite、Map Local/Remote 等高级拦截功能
- 自动系统代理仅适用于 Windows；macOS/Linux 需要手动配置代理
- Firefox、部分游戏和命令行工具可能不遵循系统代理，需要单独配置
- Windows 安装包当前未签名，SmartScreen 可能提示“未知发布者”

## License

MIT License. 本项目与 Charles 官方无关，仅用于学习和内部调试场景。
