#+#+#+#+markdown
# Cofree MVP（v0.1）

本文件定义 v0.1 的 **MVP 范围**、**黄金路径（Golden Journeys）**、以及明确的 **非目标（Non-goals）**。

> 原则：v0.1 只保证一条“可审计、可恢复、可交付”的黄金路径。

## 1. MVP 定义（一句话）
给定一个用户选择的本地 Git 仓库文件夹（工作区），Cofree 能：
**点单 → 生成计划 → 生成 patch（不落盘）→ 可视化只读 diff 审批 → 应用 patch →（可选）运行经运行时护栏检查的命令 → Git commit（最终确认）**。

## 2. Golden Journey A：从点单到 Commit
**前置条件**：用户在设置页选择一个本地 Git 仓库文件夹作为工作区；已配置模型 API Key（或启用本地模型）。

1) 用户在聊天区输入需求（点单）
2) 服务员输出：
   - 结构化计划（任务列表）
   - 将要执行的动作清单（例如：读哪些文件、生成 patch、运行哪些测试）
3) 专家执行“只读步骤”（可自动）：读取文件、生成 patch、生成测试计划等
4) UI 打开 diff 审批窗口（只读并排）
5) 用户对 diff 执行：Approve / Reject / Comment
6) 只有在 Approve 后，系统才允许写盘：apply patch
7)（可选）运行经运行时护栏检查的命令（例如 `pnpm test`）；每条命令必须经过审批
8) Git commit：展示将被提交的变更与 commit message，用户确认后执行

**成功标准**：完成一次可录屏演示（2 分钟），并能在日志中看到完整审计轨迹。

## 3. Golden Journey B：拒绝与重试（可恢复性）
1) 用户 Reject 某个 diff
2) 系统不会写盘
3) 系统基于 comment 重新生成 patch
4) 进入下一轮审批

**成功标准**：不会产生“半应用”的工作区状态；能从会话持久化中恢复。

## 4. 非目标（v0.1 不承诺）
- 不承诺强隔离 OS sandbox（v0.1 是 guardrails：审批门 + runtime guardrails + 审计）
- 不承诺复杂 Git 场景：submodules、LFS、rebase/merge 冲突自动解决、二进制文件 diff
- 不承诺任意多 agent 的自由编排（调酒台拖拽）
- 不承诺 Monaco diff 编辑/合并能力（先只读审批）

## 5. MVP 验收清单（Checklist）
- [ ] 未经用户审批，系统不会写入任何文件
- [ ] 未经用户审批，系统不会执行任何 shell 命令
- [ ] diff 审批支持 Approve/Reject/Comment
- [ ] 审计日志可导出（本地）
- [ ] Git commit 必须二次确认
- [ ] 会话可恢复（至少：从上次审批点恢复）
