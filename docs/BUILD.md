# Cofree 打包指南

本文档说明如何将 Cofree 打包为 macOS 和 Windows 可分发的安装包。

## 前置要求

### 通用要求
- Node.js 18+ 和 pnpm
- Rust 工具链（通过 [rustup](https://rustup.rs/) 安装）
- 已安装项目依赖：`pnpm install`

### macOS 打包要求
- macOS 操作系统
- Xcode Command Line Tools：`xcode-select --install`
- （可选）Apple Developer 账号用于代码签名和公证

### Windows 打包要求
- Windows 操作系统
- Visual Studio Build Tools 或 Visual Studio
- （可选）代码签名证书

### 跨平台打包
- 在 macOS 上只能打包 macOS 应用
- 在 Windows 上只能打包 Windows 应用
- 需要在对应平台上分别执行打包命令

## 自动化构建（GitHub Actions）

### 什么是 GitHub Actions

GitHub Actions 是 GitHub 官方提供的免费 CI/CD 服务：
- **公共仓库**：完全免费，无限分钟
- **私有仓库**：每月 2000 分钟免费额度
- **真实环境**：提供 macOS、Windows、Linux 虚拟机
- **并行构建**：可同时在多个平台上打包

### 自动发布流程

本项目已配置 GitHub Actions 工作流（`.github/workflows/release.yml`），实现：

1. **触发方式**
   - 推送 `v*` 格式的 tag（如 `v0.1.0`）
   - 或在 GitHub Actions 页面手动触发

2. **自动构建**
   - macOS (Apple Silicon) - 生成 `.dmg` 和 `.app`
   - macOS (Intel) - 生成 `.dmg` 和 `.app`
   - Windows - 生成 `.msi` 和 `.exe`

3. **自动发布**
   - 创建 GitHub Release 草稿
   - 上传所有平台的安装包
   - 附带下载说明

### 如何发布新版本

```bash
# 1. 更新版本号（3 个文件）
# - package.json
# - src-tauri/tauri.conf.json
# - src-tauri/Cargo.toml

# 2. 提交更改
git add .
git commit -m "chore: bump version to 0.2.0"

# 3. 创建并推送 tag
git tag v0.2.0
git push origin v0.2.0

# 4. GitHub Actions 自动开始构建
# 访问 https://github.com/J-York/Cofree/actions 查看进度

# 5. 构建完成后，在 Releases 页面编辑并发布
# https://github.com/J-York/Cofree/releases
```

### 构建时间

- **首次构建**：约 15-25 分钟（需要编译 Rust 依赖）
- **后续构建**：约 5-10 分钟（使用缓存）
- **3 个平台并行**：总耗时取决于最慢的平台

### 手动触发构建

如果不想创建 tag，可以手动触发：

1. 访问 https://github.com/J-York/Cofree/actions
2. 选择 "Release Build" 工作流
3. 点击 "Run workflow" 按钮
4. 选择分支并运行

### 故障排查

**构建失败**：
- 查看 Actions 日志：https://github.com/J-York/Cofree/actions
- 常见原因：依赖安装失败、编译错误、配置错误

**Release 未创建**：
- 确认 tag 格式正确（必须以 `v` 开头）
- 检查 `GITHUB_TOKEN` 权限（默认已配置）

## 本地打包

如果需要本地打包（不使用 GitHub Actions）：


## 打包命令

### 开发模式
```bash
# 启动开发服务器
pnpm tauri:dev
```

### 生产打包

#### 打包所有格式（当前平台）
```bash
pnpm tauri:build:all
```

#### macOS 专用打包
```bash
# 生成 .dmg 和 .app
pnpm tauri:build:mac
```

生成的文件位置：
- `src-tauri/target/release/bundle/dmg/Cofree_0.1.0_aarch64.dmg`（Apple Silicon）
- `src-tauri/target/release/bundle/dmg/Cofree_0.1.0_x64.dmg`（Intel）
- `src-tauri/target/release/bundle/macos/Cofree.app`

#### Windows 专用打包
```bash
# 生成 .msi 和 .exe（NSIS 安装器）
pnpm tauri:build:win
```

生成的文件位置：
- `src-tauri/target/release/bundle/msi/Cofree_0.1.0_x64_en-US.msi`
- `src-tauri/target/release/bundle/nsis/Cofree_0.1.0_x64-setup.exe`

#### 通用打包命令
```bash
# 使用 Tauri CLI 直接打包
pnpm tauri build

# 指定特定格式
pnpm tauri build --bundles dmg
pnpm tauri build --bundles msi,nsis
```

## 打包配置

打包配置位于 `src-tauri/tauri.conf.json`：

```json
{
  "bundle": {
    "active": true,
    "targets": ["dmg", "app", "msi", "nsis"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

### 支持的打包格式

| 平台 | 格式 | 说明 |
|------|------|------|
| macOS | `dmg` | Apple Disk Image（推荐分发格式）|
| macOS | `app` | macOS 应用程序包 |
| Windows | `msi` | Windows Installer（推荐）|
| Windows | `nsis` | NSIS 安装器（传统兼容）|

## 代码签名（可选）

### macOS 代码签名

1. 获取 Apple Developer 证书
2. 在 `tauri.conf.json` 中配置：

```json
{
  "bundle": {
    "mac": {
      "signingIdentity": "Developer ID Application: Your Name (TEAM_ID)",
      "hardenedRuntime": true,
      "entitlements": "./entitlements.plist"
    }
  }
}
```

3. 打包时自动签名：
```bash
pnpm tauri:build:mac
```

### Windows 代码签名

1. 获取代码签名证书
2. 在 `tauri.conf.json` 中配置：

```json
{
  "bundle": {
    "windows": {
      "certificateThumbprint": "YOUR_CERT_THUMBPRINT",
      "digestAlgorithm": "sha256",
      "timestampUrl": "http://timestamp.digicert.com"
    }
  }
}
```

## 常见问题

### 打包失败

**问题**：`error: failed to bundle project`

**解决方案**：
1. 确保前端构建成功：`pnpm build`
2. 检查 Rust 工具链：`rustc --version`
3. 清理缓存重试：`rm -rf src-tauri/target && pnpm tauri:build`

### 图标未显示

**问题**：打包后应用图标显示为默认图标

**解决方案**：
1. 确保图标文件存在于 `src-tauri/icons/` 目录
2. 检查 `tauri.conf.json` 中的图标路径配置
3. 重新打包

### macOS 无法打开应用

**问题**：提示"应用已损坏"或"无法验证开发者"

**解决方案**：
- 未签名应用：右键点击 → 打开 → 确认打开
- 或在终端执行：`xattr -cr /Applications/Cofree.app`

### Windows Defender 警告

**问题**：Windows Defender 阻止安装

**解决方案**：
- 未签名应用会触发 SmartScreen 警告
- 点击"更多信息" → "仍要运行"
- 建议：获取代码签名证书以避免警告

## 分发建议

### macOS
- 推荐分发 `.dmg` 文件（用户体验最佳）
- 如需 App Store 分发，需额外配置并使用 `.app` 格式

### Windows
- 推荐分发 `.msi` 文件（现代 Windows 推荐）
- `.exe`（NSIS）提供更多自定义安装选项

## 版本更新

修改版本号：
1. 更新 `package.json` 中的 `version` 字段
2. 更新 `src-tauri/tauri.conf.json` 中的 `version` 字段
3. 更新 `src-tauri/Cargo.toml` 中的 `version` 字段
4. 重新打包

## 参考资源

- [Tauri 官方文档 - 打包](https://tauri.app/v2/guides/building/)
- [Tauri 配置参考](https://tauri.app/v2/reference/config/)
- [代码签名指南](https://tauri.app/v2/guides/distribution/sign-macos/)
