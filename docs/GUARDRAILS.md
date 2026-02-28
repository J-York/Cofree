#+#+#+#+markdown
# Cofree Guardrails（v0.1）

本文件定义 v0.1 的“可控自主”边界：**允许做什么 / 禁止做什么 / 何时必须人工审批 / 如何审计与回滚**。

> v0.1 使用 Guardrails（白名单+审批门），不宣称强隔离 sandbox。

## 1. 安全原则
1) **默认只读**：未审批前，agent 只能读文件、生成计划、生成 patch（内存中）。
2) **写操作必审**：任何写盘/命令/git 写操作都必须经过审批门。
3) **最小权限**：每个 agent 仅获得完成其职责所需的最小工具集。
4) **可审计**：所有敏感动作写入审计日志。

## 2. Approval Gates（审批门）

### Gate A：Apply Patch（写盘）
- 输入：patch（建议统一为 unified diff）
- UI：只读 diff 并排预览 + Approve/Reject/Comment
- 通过后动作：将 patch 应用到工作区

### Gate B：Execute Command（命令执行）
- 输入：命令字符串 + 工作目录 + 预期目的说明
- UI：展示风险提示（读写磁盘/网络/安装依赖/危险系统命令）
- 机制：移除后端硬编码的命令白名单（即所有系统命令均支持调用），完全依赖此审批门进行风险管控
- 通过后动作：执行命令并捕获 stdout/stderr/exit code
### Gate C：Git Write（git 写操作）
- 输入：将要执行的操作（create branch / stage / commit）
- UI：展示受影响文件列表、commit message 预览
- 通过后动作：执行 git 写操作

## 3. Tool Allowlist（机制调整）
v0.1 不再在后端对具体系统命令做白名单硬校验。所有的写操作风险管控全面收束于：
- **人工审批门（HITL）**
- 工作区路径边界限制

支持的核心 Agent 能力集：
- `read_file` / `list_files`
- `create_patch` (in-memory)
- `apply_patch` (Gate A)
- `run_command` (Gate B - 全量命令支持，仅受限系统底层权限与工作区路径)
- `git_status` / `git_diff` (read-only)
- `git_stage` / `git_commit` / `git_checkout_branch` (Gate C)
## 4. 文件系统边界
- 必须限定 workspace root（用户在设置页选择的项目根目录，系统启动时不自动假定当前目录为工作区）
- 默认禁止访问：`~/.ssh`、`~/.config`、系统目录、Keychain
- 允许访问：workspace 内的源代码与配置（可按扩展名/目录做进一步限制）

## 5. 回滚与恢复（最低要求）
- 在 apply patch 前记录“工作区快照点”（至少可用：保存 `git diff` + `git status`，或创建临时分支/commit 作为锚点）
- apply 失败必须可恢复到 apply 前状态

## 6. LangGraph HITL 实现注意事项
- `interrupt()` 前避免不可逆副作用（resume 时节点会重复执行）。
- 审批事件 payload 必须可 JSON 序列化。
- 禁止把 `interrupt()` 包在会吞掉异常的 try/catch 中（会破坏暂停机制）。
