# Cofree Roadmap（v0.0.2 修订版）

> Roadmap 原则：每个 Milestone 必须产出**可演示（可录屏 2 分钟）**的可用能力。
> 以当前代码实现和业界 Agent Coding 实践为基准，务实规划后续迭代。

---

## 已完成的 Milestones

### ✅ Milestone 1 — Tauri Skeleton（v0.0.1）
- Tauri 2.0 + React 19 项目骨架
- 三页导航：聊天区 / 厨房 / 设置页
- LiteLLM provider/model 注册表
- 设置页：API Key + Base URL + egress 选项持久化

### ✅ Milestone 2 — 对话规划与工作区读能力（v0.0.1）
- LLM 工具调用循环（单 Agent + native tool calling）
- 流式聊天回复 + 结构化计划展示
- Workspace 选择/验证 + 路径边界校验
- 只读工具：read_file, list_files, git_status, git_diff
- 多轮对话历史持久化
- Local-only 约束 + LLM 最小审计日志

### ✅ Milestone 3 — HITL 审批 + Guardrails（v0.0.1）
- 工作流状态机：`planning → executing → human_review → done`
- **Gate A（Apply Patch）**：propose_file_edit（结构化编辑）+ propose_apply_patch（raw patch）→ 预检 → 快照 → 审批 → 应用 → 回滚
- **Gate B（Shell Execution）**：propose_shell（完整 shell 语法）→ 审批 → 执行 → stdout/stderr/exit code 归档
- Git 操作通过 propose_shell 统一处理（git add, git commit, git checkout 等）
- Guardrails：workspace 边界 + 灾难命令硬拦截 + 强制审批
- SQLite checkpoint 持久化与会话恢复
- 审计日志统一：动作、时间、agent、目标、结果（localStorage v1）
- 自研彩色 diff 预览 + Approve/Reject/Comment UI
- Patch 预检失败自动修复重试 + create 路径修复提示
- CI/CD：GitHub Actions 跨平台构建发布

### ✅ Milestone 4 — 可用性打磨与智能增强（v0.0.2）
- **Diff 渲染增强**：独立 `DiffViewer` 组件，支持 inline + split 双视图、文件级折叠/展开、行号显示、统计面板（files/additions/deletions/hunks）
- **Shell 执行结果展示**：独立 `ShellResultDisplay` 组件，内联展示 stdout/stderr/exit code/timeout 状态
- **错误体验优化**：独立 `ErrorBanner` 组件，分类错误（auth/network/patch_conflict/workspace/llm/unknown）+ 重试引导 + 详情展开
- **厨房页完整实现**：工作流状态可视化 + 统计面板（LLM 请求数/工具调用数/Token 用量/耗时）+ 工具调用追踪时间线 + 审计日志浏览
- **审计日志导出**：厨房页一键导出 JSON/CSV（通过 Tauri `save_file_dialog`）
- **流式输出**：streaming SSE + requestAnimationFrame 缓冲渲染 + Think-block 折叠
- **工具集扩展**：新增 `grep`（正则搜索）、`glob`（文件模式匹配）、`diagnostics`（编译诊断）、`fetch`（URL 内容获取），工具总数从 7 → 12
- **Sub-Agent 委派**：`task` 工具支持委派子任务给 planner/coder/tester 角色，每个 Sub-Agent 运行独立工具调用循环
- **对话历史智能管理**：token 估算截断 + LLM 摘要压缩（替代固定条数截断）
- **工具权限系统**：per-tool auto/ask 权限配置，支持自动执行或强制审批
- **多交付物检测**：自动检测用户请求的交付物数量，提醒 LLM 补齐缺失交付物
- **Post-patch 自动诊断**：patch 应用成功后自动运行编译检查并反馈诊断结果
- **工具调用效率监控**：50 轮上限 + 30 轮效率警告，防止无限循环
- **批量审批**：全部批准/全部拒绝按钮，减少多动作审批操作

---

## 后续 Milestones（基于 v0.0.2 状态规划）

### Milestone 5 — 上下文管理与代码理解（下一步）

**目标**：提升 LLM 对代码库的理解能力，减少用户手动指引的需要。当前已有 grep/glob/read_file 分段读取等基础能力，需要在此基础上构建更智能的上下文管理。

**可演示产物**：对一个中等规模项目（~50 文件）发起需求，系统能自动定位相关文件并生成准确的修改方案，无需用户手动指定文件路径。

- [ ] 5.1 文件树概览注入：启动会话时自动注入项目结构摘要到系统 prompt（利用已有的 `list_files` + `glob`）
- [ ] 5.2 智能上下文收集：基于 import/依赖关系自动扩展读取范围（利用已有的 `grep` 追踪引用链）
- [ ] 5.3 多文件编辑原子性：多个 propose_file_edit 打包为一次审批（当前为逐个审批或批量审批）
- [ ] 5.4 会话 context 压缩优化：改进已有的 `requestSummary` 摘要质量与触发策略
- [ ] 5.5 项目级 .cofreerc 配置：支持项目级自定义 prompt、忽略文件模式、默认工具权限

### Milestone 6 — Git 工作流增强

**目标**：提供结构化的 Git 交付体验，而非纯 shell 命令方式。

**可演示产物**：完成代码修改后，一键创建分支 + stage + commit，含 commit message 预览与编辑。

- [ ] 6.1 Git commit 专用 UI：commit message 预览/编辑 + 变更文件列表 + 确认按钮
- [ ] 6.2 自动分支创建：`cofree/<date>/<slug>` 格式，可选启用
- [ ] 6.3 Git status 仪表盘：在侧栏展示当前分支、未提交变更数
- [ ] 6.4 回滚增强：支持回退到任意快照点，而非仅最近一次

### Milestone 7 — 打包、测试与 Beta 发布

**目标**：具备公开发布条件的稳定桌面应用。

**可演示产物**：macOS .dmg 安装后即可使用，含基本使用引导。

- [ ] 7.1 自动化测试：核心流程 E2E 测试（至少覆盖 Golden Journey A）
- [ ] 7.2 崩溃恢复：未捕获异常处理 + 自动保存 checkpoint
- [ ] 7.3 首次使用引导：Onboarding UI（选择工作区 → 配置 API Key → 第一次点单）
- [ ] 7.4 隐私说明与权限提示：首次运行时展示数据使用说明
- [ ] 7.5 Beta checklist：签名 / 公证（macOS）/ 使用文档 / 反馈渠道

---

## 长期方向（v0.1+，不承诺时间）

以下方向基于业界 Agent Coding 工具演进趋势，待 v0.0.x 系列稳定后评估优先级：

- **MCP（Model Context Protocol）集成**：支持 MCP 协议扩展工具集
- **多模型路由**：不同任务阶段使用不同模型（如规划用大模型，编辑用快速模型）
- **可配置 Agent 角色**：用户自定义 prompt/工具集/权限（当前 `defaultAgents.ts` + `ToolPermissions` 的设计基础）
- **项目级记忆**：跨会话的项目上下文积累
- **协作模式**：多人共享审批队列
- **插件系统**：用户扩展工具定义
- **Sub-Agent 增强**：支持更多角色、并行执行、嵌套委派
