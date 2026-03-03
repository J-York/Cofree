# Cofree 文档索引（AI Maintainers 必读）

目标：让 AI/人类协作者在最少上下文下，仍能按同一套规范推进开发。

## 必读（v0.0.2 — 2026-03-03 修订版）
- [PRD](./PRD.md) — 产品需求与验收标准
- [MVP](./MVP.md) — 黄金路径与非目标（范围锁定）
- [Architecture](./ARCHITECTURE.md) — 技术架构（实际实现，含 Sub-Agent 委派 + 12 工具集）
- [Roadmap](./ROADMAP.md) — M1-M4 已完成 + M5-M7 后续规划
- [Guardrails](./GUARDRAILS.md) — Gate A/B 审批门 + 工具权限系统 + 安全边界 + 审计/回滚
- [Security & Privacy](./SECURITY_PRIVACY.md) — Data Egress Policy + Key 存储 + 日志约束
- [Git Support](./GIT_SUPPORT.md) — Git 支持矩阵与失败 UX
- [Development Guidelines](./DEVELOPMENT_GUIDELINES.md) — 协作规范（进度同步、HITL 规则等）
- [Build](./BUILD.md) — 打包指南（GitHub Actions CI/CD + 本地打包）

## 贡献与进度
- 根目录 [PROGRESS.md](../PROGRESS.md) — 唯一进度源（含架构偏移说明）

## 文档维护规则（必须遵守）
1) 改 PRD/架构/范围时：必须同步更新 INDEX 的链接与相关文档的交叉引用。
2) 任何新增"敏感动作"（写盘/命令/git 写）都必须先更新 Guardrails 与 Security/Privacy。
3) Roadmap 里程碑必须以"可演示产物"描述，而不是抽象能力。
4) 文档描述必须反映**实际实现**，而非初期设想。如有偏移须在 PROGRESS.md 记录。
5) 版本号使用 `v0.0.x` 格式（当前 v0.0.2），不使用 `v0.1`。
