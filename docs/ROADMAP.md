# Cofree Roadmap 说明（文档重构后）

从 `v0.0.7` 开始，`docs/` 不再把“未来路线图”作为当前主文档的一部分维护。

原因很简单：

- 仓库已经迭代过多个版本，早期 roadmap 容易和当前实现混淆。
- 这套文档现在以“当前可验证事实”为核心，而不是“预期会做什么”。
- 未来想法如果没有对应实现，放进主文档会很快过时。

## 当前约定

1. `docs/PRD.md`、`docs/MVP.md`、`docs/ARCHITECTURE.md` 只记录当前实现。
2. `docs/GUARDRAILS.md`、`docs/SECURITY_PRIVACY.md`、`docs/GIT_SUPPORT.md`、`docs/BUILD.md` 只记录当前行为与边界。
3. 如果后续需要讨论未来方案，应单独写提案、issue、ADR 或版本说明，而不是直接写回这里。

## 历史说明

本文件保留的唯一目的，是告诉后续维护者：

- 旧版 `ROADMAP.md` 中那类 milestone 规划文档已不再作为事实来源。
- 如果看到其他文档仍在引用未来 milestone、下一步计划或过时版本号，应视为待清理内容。

换句话说，当前 `docs/` 的默认姿势是：**写现在，不写猜测**。
