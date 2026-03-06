# Cofree 构建与发布说明（v0.0.7）

本文档记录当前仓库真实存在的开发、构建和发布方式。

## 1. 当前版本锚点

当前版本号应在以下三个文件保持一致：

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

当前仓库中的一致版本为 `0.0.7`。

## 2. 本地开发

### 2.1 安装依赖
- `pnpm install`

### 2.2 前端开发
- `pnpm dev`
- Vite 开发端口固定为 `1420`

### 2.3 桌面开发
- `pnpm tauri:dev`
- Tauri 开发模式会先执行 `pnpm dev`
- 前端开发地址为 `http://localhost:1420`

## 3. 本地构建

### 3.1 前端构建
- `pnpm build`
- 实际执行内容：`tsc && vite build`

### 3.2 桌面构建
- `pnpm tauri:build`
- `pnpm tauri:build:mac`
- `pnpm tauri:build:win`
- `pnpm tauri:build:all`

## 4. 当前打包目标

`src-tauri/tauri.conf.json` 当前声明的 bundle 目标：

- macOS：`dmg`、`app`
- Windows：`msi`、`nsis`

当前配置中没有 Linux bundle 目标，因此不应把 Linux 安装包写成现成产物。

## 5. GitHub Actions 发布流

仓库当前有一个 `Release Build` 工作流，特征如下：

- 触发方式：
  - 推送 `v*` tag
  - 手动触发 `workflow_dispatch`
- 构建矩阵：
  - `macos-14` / `aarch64-apple-darwin`
  - `macos-15-intel` / `x86_64-apple-darwin`
  - `windows-latest` / `x86_64-pc-windows-msvc`
- 前端构建命令：`pnpm build`
- 桌面构建动作：`tauri-apps/tauri-action`
- 会上传 updater 所需的 `latest.json` 与签名工件

## 6. 发布当前版本的一般步骤

1. 确认三个版本文件一致。
2. 提交版本变更。
3. 创建并推送形如 `v0.0.7` 的 tag。
4. 等待 GitHub Actions 生成 release 产物。

如果发布的是后续版本，也仍然沿用这个 tag 规则，而不是在文档里写死旧示例版本号。

## 7. 自动更新

当前桌面端已配置 updater：

- 读取 GitHub Release 的 `latest.json`
- 非开发模式下自动检查更新
- 下载并安装后重启应用

因此，发布流程除了安装包本身，还依赖 updater 工件完整上传。

## 8. 平台要求

### 8.1 macOS 构建
- 需在 macOS 环境下执行
- 若要签名/公证，需要额外的 Apple 开发者证书和相关配置

### 8.2 Windows 构建
- 需在 Windows 环境下执行
- 若要避免 SmartScreen 等提示，需要额外的代码签名能力

### 8.3 跨平台说明
- macOS 和 Windows 产物当前由 CI 分别在对应环境构建
- 不应假设单机一次构建能得到全部正式产物

## 9. 常见判断准则

- 如果只是验证前端是否可打包，先运行 `pnpm build`。
- 如果要验证桌面产物配置是否正确，再运行对应 `pnpm tauri:build*`。
- 若版本信息出现不一致，应先修正版本源，再进行发布。
