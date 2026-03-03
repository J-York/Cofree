# Cofree MVP（v0.0.2）— 实际实现修订版

本文件定义 v0.0.2 的 **MVP 范围**、**黄金路径（Golden Journeys）**、以及明确的 **非目标（Non-goals）**。

> 原则：v0.0.2 保证一条"可审计、可恢复、可交付"的黄金路径，并在此基础上提供智能增强能力。

## 1. MVP 定义（一句话）
给定一个用户选择的本地 Git 仓库文件夹（工作区），Cofree 能：
**点单 → LLM 工具循环分析上下文（含 grep/glob/diagnostics/fetch + Sub-Agent 委派）→ 生成 patch（不落盘）→ 彩色 diff 审批（inline/split 双视图）→ 应用 patch + 自动诊断 →（可选）运行经审批的 shell 命令 →（可选）Git commit（经审批的 shell 命令）**。

## 2. Golden Journey A：从点单到代码修改

**前置条件**：用户在设置页选择本地 Git 仓库文件夹作为工作区；已配置模型 API Key（或启用本地模型）。

1) 用户在聊天区输入需求（点单）
2) 系统通过 LLM 工具调用循环：
   - 使用 grep/glob 快速定位相关代码
   - 自动读取相关文件（read_file, list_files）
   - 查看 git 状态（git_status, git_diff）
   - 可通过 task 工具委派子任务给 Sub-Agent（planner/coder/tester）
   - 生成结构化编辑（propose_file_edit）或 raw patch（propose_apply_patch）
3) 生成的 patch 作为待审批动作卡片展示，含 DiffViewer（inline/split 双视图 + 文件级折叠/展开）
4) 用户对动作执行：Approve / Reject / Comment（支持批量审批）
5) 只有在 Approve 后，系统才允许写盘：apply patch（含预检和快照备份）+ 自动运行编译诊断
6)（可选）通过 propose_shell 执行 shell 命令（构建、测试等），每条命令必须经过审批
7)（可选）通过 propose_shell 执行 git 命令（git add, git commit 等），用户审批后执行

**成功标准**：完成一次可录屏演示，并能在厨房页审计日志中看到完整操作轨迹（支持 JSON/CSV 导出）。

## 3. Golden Journey B：拒绝与重试（可恢复性）
1) 用户 Reject 某个动作
2) 系统不会写盘
3) 系统可基于 comment 重新生成方案（通过新一轮对话）
4) 进入下一轮审批

**成功标准**：不会产生"半应用"的工作区状态；可从 SQLite checkpoint 恢复会话。

## 4. 非目标（v0.0.2 不承诺）
- 不承诺强隔离 OS sandbox（v0.0.2 是 guardrails：审批门 + runtime guardrails + 审计）
- 不承诺复杂 Git 场景：submodules、LFS、rebase/merge 冲突自动解决、二进制文件 diff
- 不承诺 Monaco diff 编辑/合并能力（当前为自研只读 diff 预览，支持 inline/split 双视图）
- 不承诺专用 Git commit UI（git 操作通过 propose_shell 统一处理）
- 不承诺多 Agent 并行执行（当前 Sub-Agent 为串行委派）

## 5. MVP 验收清单（Checklist）
- [x] 未经用户审批，系统不会写入任何文件（ask 模式下）
- [x] 未经用户审批，系统不会执行任何 shell 命令（ask 模式下）
- [x] diff 审批支持 Approve/Reject/Comment + 批量审批
- [x] 审计日志可导出（本地）— 厨房页一键导出 JSON/CSV
- [ ] Git commit 专用确认 UI — 当前通过 propose_shell 可实现，但无专用 UI
- [x] 会话可恢复（从 SQLite checkpoint 恢复到上次状态）
- [x] 流式输出减少等待感
- [x] 厨房页可展示工作流状态、工具调用追踪、审计日志
