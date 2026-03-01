#+#+#+#+markdown
# Cofree Guardrails（v0.1）

本文件定义 v0.1 的“可控自主”边界：**允许做什么 / 禁止做什么 / 何时必须人工审批 / 如何审计与回滚**。

> v0.1 使用 Guardrails（审批门 + runtime guardrails），不宣称强隔离 sandbox。

## 1. 安全原则
1) **默认只读**：未审批前，agent 只能读文件、生成计划、生成 patch（内存中）。
2) **写操作必审**：任何写盘/命令/git 写操作都必须经过审批门。
3) **最小权限**：每个 agent 仅获得完成其职责所需的最小工具集。
4) **可审计**：所有敏感动作写入审计日志。

## 2. Approval Gates（审批门）

### Gate A：Apply Patch（写盘）
- 输入：结构化文件编辑（如单文件 search/replace）或 patch；系统统一转换/校验为 patch
- UI：只读 diff 并排预览 + Approve/Reject/Comment
- 通过后动作：将 patch 应用到工作区
- 失败恢复：patch 预检失败时可触发一次自动修复重试（回传错误给模型后重试）

### Gate B：Execute Command（命令执行）
- 输入：可执行文件 `command` + 参数数组 `args` + 工作目录 + 预期目的说明
- UI：展示风险提示（读写磁盘/网络/安装依赖/危险系统命令）
- 机制：通过审批门后仍需通过运行时 guardrails（阻断 shell 控制符、越界路径、受限目录、高风险命令与解释器内联执行）
- 策略收紧：新增/修改文件优先走 Gate A；但删除整个文件时允许走 Gate B 的受审批 `rm <relative_path>`（不放宽高风险删除）
- 通过后动作：执行命令并捕获 stdout/stderr/exit code
### Gate C：Git Write（git 写操作）
- 输入：将要执行的操作（create branch / stage / commit）
- UI：展示受影响文件列表、commit message 预览
- 通过后动作：执行 git 写操作

## 3. Tool Guardrails（机制调整）
v0.1 不再使用“命令白名单”策略；改为“审批门 + 运行时 guardrails”双层控制。命令执行需要同时满足：
- **人工审批门（HITL）通过**
- 工作区路径边界与受限目录检查
- shell 控制符阻断（如 `&&` / `|` / 重定向）
- 高风险命令关键字阻断（如 `mkfs` / `shutdown` / `reboot`）
- 解释器内联执行阻断（如 `python -c` / `node -e`）
- 文件变更命令默认收紧；删除整个文件可在审批后例外使用 `rm <relative_path>`

支持的核心 Agent 能力集：
- `read_file` / `list_files`
- `propose_file_edit` (单文件结构化编辑，支持 `replace/insert/delete/create` 与按行定位，系统生成 patch)
- `propose_apply_patch` (高级 raw patch 路径，仅在明确 patch/diff 需求时启用)
- `propose_run_command` (Gate B - 结构化命令执行 + runtime guardrails)
- `git_status` / `git_diff` (read-only)
- `propose_git_write` (Gate C)
## 4. 文件系统边界
- 必须限定 workspace root（用户在设置页选择的项目根目录，系统启动时不自动假定当前目录为工作区）
- 默认禁止访问：`~/.ssh`、`~/.config`、系统目录、Keychain
- 允许访问：workspace 内的源代码与配置（可按扩展名/目录做进一步限制）

## 5. 回滚与恢复（最低要求）
- 在 apply patch 前记录“工作区快照点”（当前实现为按文件做临时快照备份，不依赖仓库必须存在 `HEAD`）
- apply 失败必须可恢复到 apply 前状态

## 6. LangGraph HITL 实现注意事项
- `interrupt()` 前避免不可逆副作用（resume 时节点会重复执行）。
- 审批事件 payload 必须可 JSON 序列化。
- 禁止把 `interrupt()` 包在会吞掉异常的 try/catch 中（会破坏暂停机制）。
