# Cofree 构建与发布说明

本文档记录当前仓库真实存在的开发、构建和发布方式。

## 1. 版本锚点

发布前必须保证以下三个文件中的版本号完全一致：

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

当前仓库 HEAD 的一致版本为 `0.1.0`。后续版本发布时，也应以这三个文件中的一致值为准，而不是修改单一来源。

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
- 如果配置了 updater 签名密钥，会上传 `latest.json` 与 updater 签名工件
- 如果没有配置 updater 签名密钥，工作流仍会继续构建，但该次 release 不会生成 updater 工件
- macOS / Windows 代码签名也是按需启用：Secrets 配齐则签名，缺失则退化为未签名构建并输出 warning

## 6. 可选 GitHub Secrets

### 6.1 Updater 签名
用于生成自动更新工件；未配置时不会上传 `latest.json` / `.sig`。

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（私钥有密码时需要）

### 6.2 macOS 代码签名与公证
基础签名 Secrets：
- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `KEYCHAIN_PASSWORD`

公证凭据二选一；都不配时仅跳过公证： 

1. App Store Connect API：
   - `APPLE_API_ISSUER`
   - `APPLE_API_KEY`
   - `APPLE_API_PRIVATE_KEY`
2. Apple ID：
   - `APPLE_ID`
   - `APPLE_PASSWORD`
   - `APPLE_TEAM_ID`

### 6.3 Windows 代码签名
- `WINDOWS_CERTIFICATE`
- `WINDOWS_CERTIFICATE_PASSWORD`
- `WINDOWS_CERTIFICATE_THUMBPRINT`
- `WINDOWS_DIGEST_ALGORITHM`
- `WINDOWS_TIMESTAMP_URL`

## 7. 发布一般步骤

1. 确认三个版本文件一致。
2. 按需配置 GitHub Secrets。
3. 提交版本变更。
4. 创建并推送形如 `v0.1.0` 的 tag（后续版本沿用 `vX.Y.Z` 规则）。
5. 等待 GitHub Actions 生成 release 产物。
6. 若本次配置了 updater 签名密钥，再额外确认 GitHub Release 中存在安装包、`latest.json` 与 updater 签名工件。

## 8. 自动更新

当前桌面端已配置 updater：

- 读取 GitHub Release 的 `latest.json`
- 非开发模式下启动后自动检查更新，并按固定间隔继续检查
- 下载并安装后重启应用
- 更新签名校验失败会在 UI 中显式暴露，不再被当成“没有更新”静默吞掉

但要注意：只有在发布流程提供 `TAURI_SIGNING_PRIVATE_KEY` 时，该次 release 才会生成新的 updater 工件。未配置该密钥时，release 仍可构建安装包，但自动更新不会随该次 release 一起更新。

## 9. 平台要求

### 9.1 macOS 构建
- 需在 macOS 环境下执行
- 若要签名/公证，需要额外的 Apple 开发者证书和相关配置

### 9.2 Windows 构建
- 需在 Windows 环境下执行
- 若要避免 SmartScreen 等提示，需要额外的代码签名能力

### 9.3 跨平台说明
- macOS 和 Windows 产物当前由 CI 分别在对应环境构建
- 不应假设单机一次构建能得到全部正式产物

## 10. 常见判断准则

- 如果只是验证前端是否可打包，先运行 `pnpm build`。
- 如果要验证桌面产物配置是否正确，再运行对应 `pnpm tauri:build*`。
- 若版本信息出现不一致，应先修正版本源，再进行发布。
- 若希望该次 release 可被自动更新识别，必须提供 updater 签名密钥；否则只能得到普通安装包发布。
