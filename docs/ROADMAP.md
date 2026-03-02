# Cofree Roadmap（修订版 — 基于 v0.1 MVP 实际实现）

> Roadmap 原则：每个 Milestone 必须产出**可演示（可录屏 2 分钟）**的可用能力。
> 以当前代码实现和业界 Agent Coding 实践为基准，务实规划后续迭代。

---

## 已完成的 Milestones

### ✅ Milestone 1 — Tauri Skeleton（已完成）
- Tauri 2.0 + React 19 项目骨架
- 三页导航：聊天区 / 厨房（占位）/ 设置页
- LiteLLM provider/model 注册表
- 设置页：API Key + Base URL + egress 选项持久化

### ✅ Milestone 2 — 对话规划与工作区读能力（已完成）
- LLM 工具调用循环（单 Agent + native tool calling）
- 流式聊天回复 + 结构化计划展示
- Workspace 选择/验证 + 路径边界校验
- 只读工具：read_file, list_files, git_status, git_diff
- 多轮对话历史持久化
- Local-only 约束 + LLM 最小审计日志

### ✅ Milestone 3 — HITL 审批 + Guardrails（已完成）
- 工作流状态机：`planning → executing → human_review → done`
- **Gate A（Apply Patch）**：propose_file_edit（结构化编辑）+ propose_apply_patch（raw patch）→ 预检 → 快照 → 审批 → 应用 → 回滚
- **Gate B（Shell Execution）**：propose_shell（完整 shell 语法）→ 审批 → 执行 → stdout/stderr/exit code 归档
- Git 操作通过 propose_shell 统一处理（git add, git commit, git checkout 等）
- Guardrails：workspace 边界 + 灾难命令硬拦截 + 强制审批
- SQLite checkpoint 持久化与会话恢复
- 审计日志统一：动作、时间、agent、目标、结果（localStorage v1）
- 自研彩色 diff 预览 + Approve/Reject/Comment UI
- Patch 预检失败自动修复重试 + create 路径修复提示
- 动态工具路由（按用户意图选择暴露工具集）
- CI/CD：GitHub Actions 跨平台构建发布

---

## 后续 Milestones（基于当前状态与业界实践）

### Milestone 4 — 可用性打磨与稳定性（下一步）

**目标**：让 MVP 从"能跑"到"好用"，修复已知痛点，具备可演示给外部用户的质量。

**可演示产物**：完整录屏演示，从打开应用到完成一次代码修改+测试+提交，流程顺畅无 blocking 错误。

- [ ] 4.1 Diff 渲染增强：并排 diff 视图（side-by-side），文件级折叠/展开
- [ ] 4.2 Shell 执行结果内联展示：stdout/stderr 实时流式输出（当前为批量返回）
- [ ] 4.3 错误体验优化：LLM 调用失败、网络超时、patch 冲突的用户友好提示与重试引导
- [ ] 4.4 厨房页实现：当前会话的工具调用追踪（调用了哪些工具、耗时、成功/失败），作为可观察性仪表盘
- [ ] 4.5 审计日志导出：一键导出 JSON/CSV 到本地文件
- [ ] 4.6 对话体验优化：流式输出（streaming）支持，减少等待感

### Milestone 5 — 上下文管理与智能增强

**目标**：提升 LLM 对代码库的理解能力，减少用户手动指引的需要。

**可演示产物**：对一个中等规模项目（~50 文件）发起需求，系统能自动定位相关文件并生成准确的修改方案。

- [ ] 5.1 文件树概览注入：启动会话时自动注入项目结构摘要到系统 prompt
- [ ] 5.2 智能上下文收集：基于 import/依赖关系自动扩展读取范围
- [ ] 5.3 大文件处理：分段读取策略优化，避免 token 浪费
- [ ] 5.4 多文件编辑原子性：多个 propose_file_edit 打包为一次审批
- [ ] 5.5 会话 context 压缩：长对话自动摘要，避免超出 context window

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

## 长期方向（v0.2+，不承诺时间）

以下方向基于业界 Agent Coding 工具演进趋势，待 v0.1 稳定后评估优先级：

- **MCP（Model Context Protocol）集成**：支持 MCP 协议扩展工具集
- **多模型路由**：不同任务阶段使用不同模型（如规划用大模型，编辑用快速模型）
- **可配置 Agent 角色**：用户自定义 prompt/工具集/权限（当前 defaultAgents.ts 的设计基础）
- **项目级记忆**：跨会话的项目上下文积累
- **协作模式**：多人共享审批队列
- **插件系统**：用户扩展工具定义
