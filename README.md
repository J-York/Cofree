# Cofree - AI 编程咖啡店

**独立开发者专属的开源 AI 编程工具**  
你只负责**点单 + 审批 + 验收**，AI 服务员 + 自定义专家团队自动干活。

- **平台**：Mac 桌面优先（Tauri 2.0）
- **模式**：本地执行 + 用户自带 API Key（详见 `docs/SECURITY_PRIVACY.md`）
- **开源**：MIT License
- **目标用户**：独立开发者

## 快速开始
1. `pnpm install`
2. 复制 `.env.example` → `.env` 并填入你的 API Key（若尚未提供该文件，请按 `docs/SECURITY_PRIVACY.md` 的建议优先使用系统安全存储）
3. `pnpm tauri dev`

详见 `docs/` 目录（建议从 `docs/INDEX.md` 开始）。

**当前开发进度**：见 [PROGRESS.md](PROGRESS.md)
