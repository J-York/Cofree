#+#+#+#+markdown
# Cofree 文档索引（AI Maintainers 必读）

目标：让 AI/人类协作者在最少上下文下，仍能按同一套规范推进开发。

## 必读（v0.1）
- [PRD](./PRD.md) — 产品需求与验收标准
- [MVP](./MVP.md) — 黄金路径与非目标（范围锁定）
- [Architecture](./ARCHITECTURE.md) — 技术选型与模块边界
- [Roadmap](./ROADMAP.md) — 8 周里程碑（可演示产物）
- [Guardrails](./GUARDRAILS.md) — 工具 Guardrails + 审批门 + 审计/回滚
- [Security & Privacy](./SECURITY_PRIVACY.md) — Data Egress Policy + Key 存储 + 日志约束
- [Git Support](./GIT_SUPPORT.md) — Git 支持矩阵与失败 UX
- [Development Guidelines](./DEVELOPMENT_GUIDELINES.md) — 协作规范（进度同步、文件头注释等）

## 贡献与进度
- 根目录 [PROGRESS.md](../PROGRESS.md) — 唯一进度源

## 文档维护规则（必须遵守）
1) 改 PRD/架构/范围时：必须同步更新 INDEX 的链接与相关文档的交叉引用。
2) 任何新增“敏感动作”（写盘/命令/git 写）都必须先更新 Guardrails 与 Security/Privacy。
3) Roadmap 里程碑必须以“可演示产物”描述，而不是抽象能力。
