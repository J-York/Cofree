# Cofree MVP（v0.1）— 实际实现修订版

本文件定义 v0.1 的 **MVP 范围**、**黄金路径（Golden Journeys）**、以及明确的 **非目标（Non-goals）**。

> 原则：v0.1 只保证一条"可审计、可恢复、可交付"的黄金路径。

## 1. MVP 定义（一句话）
给定一个用户选择的本地 Git 仓库文件夹（工作区），Cofree 能：
**点单 → LLM 工具循环分析上下文 → 生成 patch（不落盘）→ 彩色 diff 审批 → 应用 patch →（可选）运行经审批的 shell 命令 →（可选）Git commit（经审批的 shell 命令）**。

## 2. Golden Journey A：从点单到代码修改

**前置条件**：用户在设置页选择本地 Git 仓库文件夹作为工作区；已配置模型 API Key（或启用本地模型）。

1) 用户在聊天区输入需求（点单）
2) 系统通过 LLM 工具调用循环：
   - 自动读取相关文件（read_file, list_files）
   - 查看 git 状态（git_status, git_diff）
   - 生成结构化编辑（propose_file_edit）或 raw patch（propose_apply_patch）
3) 生成的 patch 作为待审批动作卡片展示，含彩色 diff 预览
4) 用户对动作执行：Approve / Reject / Comment
5) 只有在 Approve 后，系统才允许写盘：apply patch（含预检和快照备份）
6)（可选）通过 propose_shell 执行 shell 命令（构建、测试等），每条命令必须经过审批
7)（可选）通过 propose_shell 执行 git 命令（git add, git commit 等），用户审批后执行

**成功标准**：完成一次可录屏演示，并能在审计日志中看到完整操作轨迹。

## 3. Golden Journey B：拒绝与重试（可恢复性）
1) 用户 Reject 某个动作
2) 系统不会写盘
3) 系统可基于 comment 重新生成方案（通过新一轮对话）
4) 进入下一轮审批

**成功标准**：不会产生"半应用"的工作区状态；可从 SQLite checkpoint 恢复会话。

## 4. 非目标（v0.1 不承诺）
- 不承诺强隔离 OS sandbox（v0.1 是 guardrails：审批门 + runtime guardrails + 审计）
- 不承诺复杂 Git 场景：submodules、LFS、rebase/merge 冲突自动解决、二进制文件 diff
- 不承诺多 Agent 并行编排（v0.1 采用单 LLM 工具循环，与业界主流一致）
- 不承诺 Monaco diff 编辑/合并能力（当前为自研只读 diff 预览）
- 不承诺审计日志导出 UI（日志存储在 localStorage，可手动提取）
- 不承诺专用 Git commit UI（git 操作通过 propose_shell 统一处理）

## 5. MVP 验收清单（Checklist）
- [x] 未经用户审批，系统不会写入任何文件
- [x] 未经用户审批，系统不会执行任何 shell 命令
- [x] diff 审批支持 Approve/Reject/Comment
- [ ] 审计日志可导出（本地）— 数据已存储，导出 UI 待实现
- [ ] Git commit 专用确认 UI — 当前通过 propose_shell 可实现，但无专用 UI
- [x] 会话可恢复（从 SQLite checkpoint 恢复到上次状态）
