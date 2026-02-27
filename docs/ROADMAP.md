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
- LangGraph 工作流：planning → executing → human_review → done
- 所有敏感动作走 Approval Gate（写文件/命令/git 写操作）
- 本地持久化（SQLite checkpointer）+ 可恢复会话
- 审计日志（动作、时间、agent、结果）

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
