# Cofree PRD v0.0.2（实际实现修订版）

## 1. 产品定位
见 README。

## 2. 核心用户流程
1. 打开 Cofree 桌面应用并选择工作区（本地 Git 仓库文件夹）
2. 在聊天区输入需求（点单）
3. 系统通过 LLM 工具调用循环自动分析需求、读取文件、生成编辑方案
4. 敏感操作（写文件、执行命令、git 操作）生成待审批动作卡片
5. 用户在 diff 预览界面执行 Approve / Reject / Comment
6. 审批通过后系统执行操作，展示结果
7. 用户可通过 `propose_shell` 执行 `git commit` 完成代码提交

## 3. 功能列表 & Priority

> v0.0.2 以"可审计的黄金路径 + 智能增强"为核心：
> **LLM 工具循环读取上下文（含 grep/glob/diagnostics/fetch + Sub-Agent 委派）→ 生成 patch（不落盘）→ 彩色 diff 审批（inline/split 双视图 + Approve/Reject/Comment + 批量审批）→ 应用 patch + 自动诊断 →（可选）运行经审批的 shell 命令 → Git commit（经审批的 shell 命令）**。

### P0（已实现）
- LLM 工具调用编排循环 + Sub-Agent 委派（planner/coder/tester）
- 结构化文件编辑（propose_file_edit：replace/insert/delete/create + 行定位）
- 独立 DiffViewer 组件（inline + split 双视图、文件级折叠/展开）+ Approve/Reject/Comment + 批量审批
- Guardrails（workspace 边界校验 + 灾难命令拦截 + 审批门 + 审计日志）
- Patch 预检 + 失败自动修复重试 + 快照回滚 + Post-patch 自动诊断
- Shell 命令执行（propose_shell：完整 shell 语法 + 超时控制）+ ShellResultDisplay 内联展示
- SQLite checkpoint 会话持久化与恢复
- 厨房仪表盘（工作流状态/统计/工具追踪/审计日志 + JSON/CSV 导出）
- 流式输出（streaming SSE + Think-block 折叠）
- 错误分类与友好提示（ErrorBanner：auth/network/patch_conflict/workspace/llm/unknown）
- 工具集扩展（grep/glob/diagnostics/fetch/task）
- 工具权限系统（per-tool auto/ask）
- 对话历史智能管理（token 估算截断 + LLM 摘要压缩）
- 多交付物检测与提醒

### P1（后续增强）
- 更丰富的 diff 渲染（hunk 级审批）
- 专用 Git commit UI
- 项目级 .cofreerc 配置
- 文件树概览自动注入

## 4. v0.0.2 验收标准（MVP）

### 4.1 黄金路径（Golden Journey）
- [x] 用户在设置页选择本地 Git 仓库作为工作区；系统验证目录有效性。
- [x] 用户点单后，系统通过 LLM 工具调用自动读取上下文并生成**待审批的 patch**（未写入磁盘）。
- [x] 用户在 diff 预览界面可执行：Approve / Reject / Comment（action 级 + 批量审批）。
- [x] 未经明确 Approve：系统**不会**写入任何文件、不会执行任何 shell 命令（ask 模式下）。
- [x] 用户 Approve 后：系统将 patch 应用到工作区，展示成功/失败结果 + 自动运行编译诊断。
- [ ] Git commit：通过 `propose_shell` 提交 git 命令，用户审批后执行。（功能可用，但无专用 commit UI）

### 4.2 可观察性与可恢复性
- [x] 所有敏感动作记录到本地审计日志（含时间、动作类型、目标、结果）。
- [x] 厨房页展示工作流状态、统计面板、工具调用追踪时间线、审计日志浏览。
- [x] 审计日志支持一键导出 JSON/CSV。
- [x] Patch apply 失败时自动回滚到快照点，ErrorBanner 展示分类错误原因与重试引导。
- [x] 应用重启后可从 SQLite checkpoint 恢复会话状态。

### 4.3 反目标（Non-goals）
- v0.0.2 不承诺强隔离 OS sandbox（以 guardrails 为主）。
- v0.0.2 不承诺覆盖复杂 Git 场景（如 submodules/LFS/冲突自动解决）。
- v0.0.2 不承诺多 Agent 并行执行（Sub-Agent 为串行委派）。
- v0.0.2 不承诺 Monaco diff 编辑/合并能力。
