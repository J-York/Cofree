# Cofree 文档索引（v0.0.8）

本文档集只描述 **当前仓库已经实现并可从代码验证的事实**，不再把早期设想、未来规划或里程碑猜测混在主文档里。

## 建议阅读顺序
- [PRD](./PRD.md) — 当前产品定位、目标用户、核心页面与能力边界
- [MVP](./MVP.md) — 当前交付范围、黄金路径、非目标与验收基线
- [ARCHITECTURE](./ARCHITECTURE.md) — 桌面端架构、模块分工、工具链路、持久化与运行流

## 专题文档
- [GUARDRAILS](./GUARDRAILS.md) — 审批门、默认工具权限、路径/命令安全边界、回滚与恢复
- [SECURITY_PRIVACY](./SECURITY_PRIVACY.md) — 数据外发边界、API Key 存储、审计日志与本地数据落点
- [GIT_SUPPORT](./GIT_SUPPORT.md) — 当前 Git 相关能力、限制和失败行为
- [BUILD](./BUILD.md) — 本地开发、桌面构建、版本发布与 CI 流水线
- [DEVELOPMENT_GUIDELINES](./DEVELOPMENT_GUIDELINES.md) — 文档维护与协作约定

## 历史说明
- [ROADMAP](./ROADMAP.md) — 仅保留文档重构后的历史说明，不再承载未来规划

## 文档维护原则
1. 文档必须以当前代码和配置为准，不能沿用过时版本描述。
2. 涉及安全边界、审批策略、数据外发、存储位置的改动，必须同步更新对应专题文档。
3. 如需提出未来想法，应单独写提案或 issue，不直接写入当前状态文档。
4. 版本信息以 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 为准。
