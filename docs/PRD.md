# Cofree PRD v0.1（实际实现修订版）

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

> v0.1 以"可审计的黄金路径"为核心：
> **LLM 工具循环读取上下文 → 生成 patch（不落盘）→ 彩色 diff 审批（Approve/Reject/Comment）→ 应用 patch →（可选）运行经审批的 shell 命令 → Git commit（经审批的 shell 命令）**。

### P0（已实现）
- 单 LLM 工具调用编排循环（含动态工具路由）
- 结构化文件编辑（propose_file_edit：replace/insert/delete/create + 行定位）
- 自研彩色 diff 预览 + Approve/Reject/Comment 审批
- Guardrails（workspace 边界校验 + 灾难命令拦截 + 强制审批门 + 审计日志）
- Patch 预检 + 失败自动修复重试 + 快照回滚
- Shell 命令执行（propose_shell：完整 shell 语法 + 超时控制）
- SQLite checkpoint 会话持久化与恢复

### P1（后续增强）
- 厨房仪表盘（当前为占位页）
- 更丰富的 diff 渲染（并排视图、hunk 级审批）
- Agent 角色配置（当前角色定义为元数据，未作为独立 Agent 使用）
- 审计日志导出 UI

## 4. v0.1 验收标准（MVP）

### 4.1 黄金路径（Golden Journey）
- [x] 用户在设置页选择本地 Git 仓库作为工作区；系统验证目录有效性。
- [x] 用户点单后，系统通过 LLM 工具调用自动读取上下文并生成**待审批的 patch**（未写入磁盘）。
- [x] 用户在 diff 预览界面可执行：Approve / Reject / Comment（action 级）。
- [x] 未经明确 Approve：系统**不会**写入任何文件、不会执行任何 shell 命令。
- [x] 用户 Approve 后：系统将 patch 应用到工作区，展示成功/失败结果。
- [ ] Git commit：通过 `propose_shell` 提交 git 命令，用户审批后执行。（功能可用，但无专用 commit UI）

### 4.2 可观察性与可恢复性
- [x] 所有敏感动作记录到本地审计日志（含时间、动作类型、目标、结果）。
- [x] Patch apply 失败时自动回滚到快照点，UI 展示错误原因。
- [x] 应用重启后可从 SQLite checkpoint 恢复会话状态。

### 4.3 反目标（Non-goals）
- v0.1 不承诺强隔离 OS sandbox（以 guardrails 为主）。
- v0.1 不承诺覆盖复杂 Git 场景（如 submodules/LFS/冲突自动解决）。
- v0.1 不承诺多 Agent 并行编排（采用单 LLM 工具循环）。
- v0.1 不承诺 Monaco diff 编辑/合并能力。
