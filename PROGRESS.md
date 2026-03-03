# Cofree 开发进度追踪（必须实时维护）

**Last Updated**: 2026-03-03 by Aone Copilot
**当前版本**: v0.0.2
**当前 Milestone**: 4.0 - 可用性打磨与稳定性（Completed）
**Next Task**: Milestone 5 — 上下文管理与智能增强

## Milestone 0: 项目初始化与文档（Completed）
- [x] 创建仓库 & 初始化文档包
- [x] 编写所有开发文档
- [x] 定义进度同步规范

## Milestone 1: Tauri 项目骨架（Completed）
- [x] 1.1 创建 Tauri 2.0 + React 19 项目（含聊天/厨房/设置导航）
- [x] 1.2 配置 LiteLLM + 多模型支持（provider/model 注册表 + 请求配置模块）
- [x] 1.3 实现基础设置页（API Key + Base URL + egress 选项本地持久化）

## Milestone 2: 对话规划与工作区读能力（Completed）
- [x] 2.1 LLM 工具调用循环（单 Agent + native tool calling，非 LangGraph）
- [x] 2.2 流式聊天回复 + 结构化计划展示 + pending 动作展示（不执行）
- [x] 2.3 Workspace 选择/验证 + workspace 边界内文件与 git 只读命令
- [x] 2.4 Local-only 约束与 LLM 最小审计日志
- [x] 2.5 多轮对话与会话历史持久化恢复

## Milestone 3: HITL 审批 + Guardrails（Completed）
- [x] 3.1 状态机骨架：`planning → executing → human_review → done`
- [x] 3.2 Gate A（Apply Patch）：propose_file_edit（结构化编辑）+ propose_apply_patch（raw patch）→ 预检 → 快照 → 审批 → 应用 → 回滚
- [x] 3.3 Gate B（Shell Execution）：propose_shell（完整 shell 语法）→ 审批 → 执行 → stdout/stderr/exit code 归档
- [x] 3.4 Git 写操作通过 propose_shell 统一处理（git add/commit/checkout 等）
- [x] 3.5 Guardrails 执行层：workspace 边界 + 灾难命令硬拦截 + 动态工具路由 + 强制审批
- [x] 3.6 SQLite checkpoint：审批点持久化与会话恢复
- [x] 3.7 审计日志统一：动作、时间、agent、目标、结果（localStorage v1）
- [x] 3.8 自研彩色 diff 预览 + Approve/Reject/Comment UI
- [x] 3.9 Patch 预检失败自动修复重试 + create 路径修复提示
- [x] 3.10 CI/CD：GitHub Actions 跨平台构建发布

### Milestone 3 验收标准
- [x] 未审批前，不能触发任何写盘/命令/git 写副作用
- [x] 每个敏感动作都能进入审批 UI，支持 Approve / Reject / Comment
- [x] Reject 后可继续下一轮生成，不产生半完成状态
- [x] 审批后执行结果可追踪（成功/失败 + 原因 + 时间 + 执行者）
- [x] 重启应用后可恢复到上一个审批点继续执行

## Milestone 4: 可用性打磨与稳定性（Completed — v0.0.2）
- [x] 4.1 Diff 渲染增强：独立 `DiffViewer` 组件，支持 inline + split 双视图、文件级折叠/展开、行号显示、统计面板
- [x] 4.2 Shell 执行结果内联展示：独立 `ShellResultDisplay` 组件，展示 stdout/stderr/exit code/timeout 状态
- [x] 4.3 错误体验优化：独立 `ErrorBanner` 组件，分类错误（auth/network/patch_conflict/workspace/llm/unknown）+ 重试引导 + 详情展开
- [x] 4.4 厨房页实现：工作流状态可视化 + 统计面板（LLM 请求数/工具调用数/Token 用量/耗时）+ 工具调用追踪时间线 + 审计日志浏览
- [x] 4.5 审计日志导出：厨房页一键导出 JSON/CSV（通过 Tauri `save_file_dialog`）
- [x] 4.6 对话体验优化：流式输出（streaming SSE）+ requestAnimationFrame 缓冲渲染 + Think-block 折叠
- [x] 4.7 新增工具能力：`grep`（正则搜索）、`glob`（文件模式匹配）、`diagnostics`（编译诊断）、`fetch`（URL 内容获取）
- [x] 4.8 Sub-Agent 委派架构：`task` 工具支持委派子任务给 planner/coder/tester 角色
- [x] 4.9 对话历史智能管理：token 估算截断 + LLM 摘要压缩（替代固定条数截断）
- [x] 4.10 工具权限系统：per-tool auto/ask 权限配置，支持自动执行或强制审批
- [x] 4.11 多交付物检测与提醒：自动检测用户请求的交付物数量，提醒 LLM 补齐缺失交付物
- [x] 4.12 Post-patch 自动诊断：patch 应用成功后自动运行编译检查并反馈诊断结果
- [x] 4.13 工具调用效率监控：50 轮上限 + 30 轮效率警告，防止无限循环
- [x] 4.14 批量审批：全部批准/全部拒绝按钮，减少多动作审批操作

### Milestone 4 验收标准
- [x] 完整录屏演示，从打开应用到完成一次代码修改+测试+提交，流程顺畅无 blocking 错误
- [x] 厨房页可展示当前会话的工具调用追踪、LLM 请求统计、审计日志
- [x] 审计日志可一键导出 JSON/CSV
- [x] 流式输出减少等待感，Think-block 可折叠

## Milestone 5: 上下文管理与智能增强（Pending — 下一步）
- [ ] 5.1 文件树概览注入：启动会话时自动注入项目结构摘要到系统 prompt
- [ ] 5.2 智能上下文收集：基于 import/依赖关系自动扩展读取范围
- [ ] 5.3 大文件处理：分段读取策略优化，避免 token 浪费（部分已实现：read_file 支持 start_line/end_line + smartTruncate）
- [ ] 5.4 多文件编辑原子性：多个 propose_file_edit 打包为一次审批
- [ ] 5.5 会话 context 压缩：长对话自动摘要（已实现基础版 requestSummary），需优化摘要质量与触发策略

## Milestone 6: Git 工作流增强（Pending）
- [ ] 6.1 Git commit 专用 UI：commit message 预览/编辑 + 变更文件列表 + 确认按钮
- [ ] 6.2 自动分支创建：`cofree/<date>/<slug>` 格式，可选启用
- [ ] 6.3 Git status 仪表盘：在侧栏展示当前分支、未提交变更数
- [ ] 6.4 回滚增强：支持回退到任意快照点，而非仅最近一次

## Milestone 7: 打包、测试与 Beta 发布（Pending）
- [ ] 7.1 自动化测试：核心流程 E2E 测试（至少覆盖 Golden Journey A）
- [ ] 7.2 崩溃恢复：未捕获异常处理 + 自动保存 checkpoint
- [ ] 7.3 首次使用引导：Onboarding UI（选择工作区 → 配置 API Key → 第一次点单）
- [ ] 7.4 隐私说明与权限提示：首次运行时展示数据使用说明
- [ ] 7.5 Beta checklist：签名 / 公证（macOS）/ 使用文档 / 反馈渠道

---

## 架构偏移说明

### v0.0.1 → v0.0.2 架构演进（2026-03-03 更新）

1. **单 LLM 循环 → Sub-Agent 委派**：新增 `task` 工具，支持将子任务委派给 planner/coder/tester 角色的 Sub-Agent，每个 Sub-Agent 运行独立的工具调用循环。
2. **ChatPage 内嵌 diff → 独立组件化**：`DiffViewer`、`ShellResultDisplay`、`ErrorBanner` 抽取为独立组件，支持 inline/split 双视图。
3. **厨房页从占位 → 完整仪表盘**：实现工作流状态可视化、统计面板、工具调用时间线、审计日志浏览与导出。
4. **工具集扩展**：从 7 个工具（list_files/read_file/git_status/git_diff/propose_file_edit/propose_apply_patch/propose_shell）扩展到 12 个（新增 grep/glob/task/diagnostics/fetch）。
5. **对话历史管理升级**：从固定条数截断（16→40 条）升级为 token 估算 + LLM 摘要压缩。
6. **工具权限系统**：新增 per-tool auto/ask 权限配置（`ToolPermissions`），支持跳过审批直接执行。
7. **工具调用上限提升**：`MAX_TOOL_LOOP_TURNS` 从 6→15→50，新增 30 轮效率警告阈值。

### v0.0.1 初期架构偏移（2026-03-02 记录）

1. **LangGraph → 自研编排循环**：未使用 LangGraph，改为自研的 TypeScript 工具调用循环（`planningService.ts`）。
2. **多 Agent → 单 LLM 循环**：未实现多 Agent 并行编排（v0.0.2 通过 Sub-Agent 委派部分实现）。
3. **jsdiff + diff2html → 自研 diff 渲染**：未引入第三方 diff 库。
4. **Gate C → Gate B 统一**：Git 写操作通过 `propose_shell` 统一在 Gate B 处理。
5. **Gate B 安全模型**：从"结构化命令 + shell 控制符阻断"转为"完整 shell 字符串 + 人类审批 + 灾难命令硬拦截"。

---

**更新规则**（所有开发者必须遵守）：
1. 每次完成一个子任务 → 立即编辑本文件，打钩 + 更新时间 + 签名
2. Git commit 建议包含 `progress:` 前缀，例如 `progress: complete 4.1 diff rendering`
3. 每天结束时 push PROGRESS.md

## Implementation Log
- 2026-03-03: v0.0.2 文档全面更新 — 标记 M4 全部完成，反映 Sub-Agent/grep/glob/diagnostics/fetch/DiffViewer/ShellResultDisplay/ErrorBanner/KitchenPage/streaming/token-based-truncation 等新增实现。
- 2026-03-02: 全文档修订 — 对齐实际实现与文档描述，消除 LangGraph/多Agent/jsdiff/Gate C 等过期引用，重写 Roadmap M4-M7。
- 2026-03-01: Improve edit reliability by adding `propose_file_edit` with structured single-file ops (`replace/insert/delete/create`) plus line-based targeting (`line` / `start_line` / `end_line`) that auto-generate patch, add patch preflight (`check_workspace_patch`) before proposal/approval apply, add one-shot automatic patch-repair retry loop, add one-shot auto-hint loops for whole-file delete (`propose_shell` + `rm <relative_path>`) and missing create paths (`operation='create'`), dynamically route each request to a reduced tool set (read-only / structured edit / explicit patch / delete-file / command / git), and upgrade HITL apply-patch UI to show structured summary + colored diff preview with raw patch collapsed by default.

## Docs Update Log
- 2026-03-03: v0.0.2 全文档更新 — 版本号统一为 v0.0.2，PROGRESS/ROADMAP/ARCHITECTURE/MVP/PRD/GUARDRAILS/INDEX 全部更新为反映实际实现。
- 2026-03-02: 全文档修订 — PRD、MVP、Architecture、Roadmap、Guardrails、Security/Privacy、Git Support、Development Guidelines、Progress 全部更新为反映实际实现。
- 2026-02-27: Add MVP scope, guardrails, security/privacy, git support docs; update PRD/Roadmap/Architecture to lightweight diff (`jsdiff` + `diff2html`) and clarify non-goals.
- 2026-02-27: Expand Week 2 planning in `docs/ROADMAP.md` with scope boundaries, task packages (M2.1~M2.5), acceptance checklist, and risk controls; sync Milestone 2 execution template in `PROGRESS.md`.
- 2026-02-27: Expand Milestone 3 planning in `docs/ROADMAP.md` (M3.1~M3.7 + acceptance checklist) and sync M3 plan into `PROGRESS.md`; simplify Milestone 2 records.
