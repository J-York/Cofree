# Cofree PRD v0.1

## 1. 产品定位
见 README。

## 2. 核心用户流程
1. 打开 Cofree（菜单栏图标）
2. 在聊天框点单（自然语言）
3. 服务员生成计划 + 团队推荐
4. 用户 Approve / 修改专家
5. 专家并行工作 + 实时厨房仪表盘
6. 每个节点 Mac Notification + 可视化 diff 审批
7. 最终交付 Git commit + 一键打开项目文件夹

## 3. 功能列表 & Priority

> 说明：为了保证 MVP 可交付性，v0.1 以“可审计的黄金路径”为核心：
> **生成 patch（不落盘）→ 可视化只读 diff 审批（Approve/Reject/Comment）→ 应用 patch →（可选）运行 allowlisted 命令 → Git commit（最终确认）**。
>
> v0.1 默认采用轻量 diff（`jsdiff` + `diff2html`）实现并排只读审批；Monaco Diff 作为后续升级项。

### P0（必须有）
- 服务员 + 3 专家（Planner / Coder / Tester）
- 可视化 diff 审批（只读并排，`jsdiff` + `diff2html`）
- 自定义专家（JSON 配置：模型/提示词/工具集/权限边界）
- Guardrails（工具白名单 + 文件读写边界 + 强制审批门 + 审计日志）

### P1（有则更好）
- 厨房仪表盘（实时状态：每个专家在做什么、正在等待什么审批）
- 本地 Git 集成（受支持范围内：创建分支、应用 patch、stage、commit）
- Monaco Diff 升级（在确有“可编辑/合并”需求时引入）

## 4. v0.1 验收标准（MVP）
以下验收标准以“可测试 / 可录屏演示”为准。

### 4.1 黄金路径（Golden Journey）
- 给定一个本地 Git 仓库：用户点单后，系统能生成一份**可预览的 patch**（未写入磁盘）。
- 用户在 diff 界面可执行：Approve / Reject / Comment（至少支持 file 级；hunk 级作为加分项）。
- 未经明确 Approve：系统**不得**写入任何文件、不得执行任何 shell 命令。
- 用户 Approve 后：系统将 patch 应用到工作区；并能展示应用结果（成功/失败及原因）。
- Git commit：必须在用户最终确认后才创建；commit message 可预览与编辑。

### 4.2 可观察性与可恢复性
- 所有“敏感动作”（写文件/执行命令/git 写操作）都记录到本地审计日志（含时间、操作者 agent、动作类型、目标、结果）。
- 发生错误（patch apply / git 操作失败）时：UI 有明确提示，且不会留下半完成的不可追踪状态。

### 4.3 反目标（Non-goals）
- v0.1 不承诺强隔离 OS sandbox（以 guardrails 为主）。
- v0.1 不承诺覆盖复杂 Git 场景（如 submodules/LFS/冲突自动解决）。
