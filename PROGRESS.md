# Cofree 开发进度追踪（必须实时维护）

**Last Updated**: 2026-03-01 02:03 CST by Codex-GPT-5
**当前 Milestone**: 3.0 - HITL 审批 + Guardrails（Completed）
**Next Task**: 进入 Milestone 4 规划与最小可演示链路定义

## Milestone 0: 项目初始化与文档（Completed）
- [x] 创建仓库 & 初始化文档包
- [x] 编写所有开发文档
- [x] 定义进度同步规范

## Milestone 1: Tauri 项目骨架（Completed）
- [x] 1.1 创建 Tauri 2.0 + React 19 项目（含聊天/厨房/设置导航）
- [x] 1.2 配置 LiteLLM + 多模型支持（provider/model 注册表 + 请求配置模块）
- [x] 1.3 实现基础设置页（API Key + Base URL + egress 选项本地持久化）

**Acceptance Criteria for Milestone 1**：
- [x] 前端构建通过（`npm run build`，含 TypeScript 校验）
- [x] 设置页可保存 API Key 到本地（`localStorage`）
- [x] PROGRESS.md 已更新

## Milestone 2: 对话规划与工作区读能力（Completed, Simplified）
- [x] 2.1-2.3 聊天流式回复 + 结构化计划 + Pending 动作展示（不执行）
- [x] 2.4 local-only 约束与 LLM 最小审计日志
- [x] 2.5 workspace 选择/验证 + workspace 边界内文件与 git 只读命令
- [x] 2.6 多轮对话与会话历史持久化恢复

**Acceptance Criteria for Milestone 2（简版）**：
- [x] 规划链路稳定可演示，敏感动作仅 Pending 展示
- [x] 未审批前无写盘、无命令执行、无 git 写操作
- [x] workspace 上下文与路径边界校验生效

## Milestone 3: HITL 审批 + Guardrails（Completed）
- [x] 3.1 状态机骨架：`planning → executing → human_review → done`
- [x] 3.2 Gate A（Apply Patch）：审批后写盘 + 失败回滚（tracked + untracked）
- [x] 3.3 Gate B（Run Command）：allowlist + 超时控制 + 执行结果归档
- [x] 3.4 Gate C（Git Write）：create branch / stage / commit（最终确认）
- [x] 3.5 Guardrails 执行层：workspace 边界 + agent-tool 权限映射 + 强制审批中断
- [x] 3.6 SQLite checkpointer：审批点持久化与会话恢复
- [x] 3.7 审计日志统一：动作、时间、agent、目标、结果、审批信息（localStorage v1）

**Acceptance Criteria for Milestone 3**：
- [x] 未审批前，不能触发任何写盘/命令/git 写副作用
- [x] 每个敏感动作都能进入审批 UI，支持 Approve / Reject / Comment
- [x] Reject 后可继续下一轮生成，不产生半完成状态
- [x] 审批后执行结果可追踪（成功/失败 + 原因 + 时间 + 执行者）
- [x] 重启应用后可恢复到上一个审批点继续执行

**更新规则**（所有开发者必须遵守）：
1. 每次完成一个子任务 → 立即编辑本文件，打钩 + 更新时间 + 签名
2. Git commit 必须包含 `progress:` 前缀，例如 `progress: complete 1.1 tauri skeleton`
3. 每天结束时必须 push PROGRESS.md

## Implementation Log
- 2026-03-01: Improve edit reliability by adding `propose_file_edit` with structured single-file ops (`replace/insert/delete/create`) plus line-based targeting (`line` / `start_line` / `end_line`) that auto-generate patch, add patch preflight (`check_workspace_patch`) before proposal/approval apply, add one-shot automatic patch-repair retry loop, add one-shot auto-hint loops for whole-file delete (`propose_run_command` + `rm <relative_path>`) and missing create paths (`operation='create'`), dynamically route each request to a reduced tool set (read-only / structured edit / explicit patch / delete-file / command / git), and upgrade HITL apply-patch UI to show structured summary + colored diff preview with raw patch collapsed by default.


## Docs Update Log
- 2026-02-27: Add MVP scope, guardrails, security/privacy, git support docs; update PRD/Roadmap/Architecture to lightweight diff (`jsdiff` + `diff2html`) and clarify non-goals.
- 2026-02-27: Expand Week 2 planning in `docs/ROADMAP.md` with scope boundaries, task packages (M2.1~M2.5), acceptance checklist, and risk controls; sync Milestone 2 execution template in `PROGRESS.md`.
- 2026-02-27: Expand Milestone 3 planning in `docs/ROADMAP.md` (M3.1~M3.7 + acceptance checklist) and sync M3 plan into `PROGRESS.md`; simplify Milestone 2 records.
