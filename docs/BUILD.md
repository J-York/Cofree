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
