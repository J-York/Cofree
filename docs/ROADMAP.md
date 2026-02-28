# Cofree Roadmap（MVP 8 周）

> Roadmap 原则：每个 Milestone 必须产出**可演示（可录屏 2 分钟）**的可用能力。
> v0.1 优先打通黄金路径：patch（不落盘）→ diff 审批 → apply →（可选）命令执行 → git commit。

**Week 1**：Milestone 1 - Tauri Skeleton（今天开始）
- 可在 Mac 上 `pnpm tauri dev` 启动应用
- 基础导航：聊天区 / 厨房（占位）/ 设置页

**Week 2**：Milestone 2 - 服务员对话 + 计划生成（可流式输出）
- 点单→生成计划（结构化）
- 生成“待审批动作列表”（不执行）

**Week 3-4**：Milestone 3 - HITL 审批 + Guardrails（核心风险燃尽）
- 目标交付物：可演示的端到端 HITL 审批流（至少覆盖 Gate A/B/C 各一次）
- M3.1 状态机骨架：LangGraph 工作流 `planning → executing → human_review → done`
- M3.2 Gate A（Apply Patch）：统一 patch 结构、审批后写盘、失败可回滚
- M3.3 Gate B（Run Command）：命令 allowlist、超时控制、stdout/stderr/exit code 归档
- M3.4 Gate C（Git Write）：create branch / stage / commit（最终确认）
- M3.5 Guardrails 执行层：workspace 边界校验、agent-tool 权限映射、敏感动作强制中断审批
- M3.6 会话持久化：SQLite checkpointer + 从审批点恢复
- M3.7 审计链路：统一动作日志结构（动作、时间、agent、目标、结果、审批人）+ 本地导出

**Week 5**：Milestone 4 - 轻量可视化 diff（v0.1 版本）
- `jsdiff` + `diff2html` 并排只读 diff
- Approve / Reject / Comment
- 通过后才能 apply patch

**Week 6**：Milestone 5 - 自定义团队（先收敛后扩展）
- 固定角色集（Planner/Coder/Tester）+ 可配置模型/提示词
- 配置保存/加载（JSON + 版本号）

**Week 7**：Milestone 6 - Git 交付（受支持范围内）
- 创建分支（可选）/ stage / commit（最终确认）
- 失败处理与回滚（至少支持回到 apply 前快照）

**Week 8**：Milestone 7 - 打包、测试、Beta 发布
- 基础稳定性：崩溃恢复、错误提示、日志导出
- Beta checklist（隐私说明、权限提示、基础使用文档）

每个 Milestone 结束时更新 PROGRESS.md 并 @我（Grok PM）review。
