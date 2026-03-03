# Cofree Guardrails（v0.0.2）— 实际实现修订版

本文件定义 v0.0.2 的"可控自主"边界：**允许做什么 / 禁止做什么 / 何时必须人工审批 / 如何审计与回滚**。

> v0.0.2 使用 Guardrails（审批门 + runtime guardrails），不宣称强隔离 sandbox。
> v0.0.2 新增工具权限系统（`ToolPermissions`），每个写操作工具可独立配置为 `ask`（需审批）或 `auto`（自动执行）。

## 1. 安全原则
1) **默认只读**：未审批前，LLM 只能读文件、查看 git 状态、生成方案（内存中）。
2) **写操作必审**：任何写盘/命令/git 写操作都必须经过审批门。
3) **最小权限**：系统通过动态工具路由控制 LLM 可用工具集。
4) **可审计**：所有敏感动作写入审计日志。

## 2. Approval Gates（审批门）

v0.1 存在**两类**审批门：

### Gate A：Apply Patch（写盘）
- 输入：unified diff patch
  - 由 `propose_file_edit` 生成（支持 replace/insert/delete/create + 行定位，系统自动转换为 patch）
  - 或由 `propose_apply_patch` 直接提交 raw unified diff
- 流程：patch 预检（check_workspace_patch）→ 快照备份 → UI 彩色 diff 预览 → 用户 Approve/Reject/Comment → 应用
- 失败恢复：
  - 预检失败：触发一次自动修复重试（回传错误给 LLM 重新生成）
  - 应用失败：自动从快照回滚
- UI：彩色 diff 预览（+绿/-红）+ 结构化摘要 + raw patch 折叠展示

### Gate B：Shell Execution（命令执行 + Git 写操作）
- 输入：完整 shell 命令字符串（`propose_shell`）
- 覆盖范围：
  - 构建命令：`npm install`, `cargo build`, `pnpm test` 等
  - 文件操作：`rm`, `mkdir`, `cp` 等
  - Git 操作：`git add`, `git commit`, `git checkout -b` 等
  - 任意 shell 语法：管道 `|`、重定向 `>`、链式 `&&` 等
- 安全模型："人类看到并审批完整命令" + 灾难性命令硬拦截
- 超时控制：1,000ms - 600,000ms（默认 120,000ms）
- 通过后动作：通过 `sh -c` 执行，捕获 stdout/stderr/exit code
- UI：命令文本预览 + 超时设置 + Approve/Reject

> 注：初期设想的 Gate C（Git Write 独立门）已被 Gate B 统一覆盖。Git 写操作等同于 shell 命令执行。

## 3. 灾难性命令拦截（硬拦截）

以下命令在 Rust 后端层硬拦截，即使用户审批也不执行：
- `rm -rf /` 及其变体
- `mkfs` 系列
- `shutdown` / `reboot`
- Fork bomb 模式

## 4. LLM 可用工具集

| 工具 | 类型 | 说明 |
|------|------|------|
| `list_files` | 只读 | 列出目录内容 |
| `read_file` | 只读 | 读取文件内容（支持行范围分段读取） |
| `git_status` | 只读 | 查看 git 状态 |
| `git_diff` | 只读 | 查看 git diff |
| `grep` | 只读 | 正则表达式搜索文件内容（v0.0.2 新增） |
| `glob` | 只读 | 文件模式匹配搜索（v0.0.2 新增） |
| `diagnostics` | 只读 | 编译诊断（自动检测项目类型）（v0.0.2 新增） |
| `fetch` | 只读 | URL 内容获取（白名单域名限制）（v0.0.2 新增） |
| `propose_file_edit` | Gate A | 结构化文件编辑（replace/insert/delete/create），系统生成 patch |
| `propose_apply_patch` | Gate A | 提交 raw unified diff patch |
| `propose_shell` | Gate B | 提交 shell 命令（含 git 操作） |
| `task` | 委派 | 委派子任务给 Sub-Agent（planner/coder/tester）（v0.0.2 新增） |

每个 Gate A/B 工具可通过 `ToolPermissions` 配置为 `ask`（默认，需审批）或 `auto`（自动执行）。

## 5. 文件系统边界
- 必须限定 workspace root（用户在设置页选择的项目根目录）
- 禁止 `..` 路径穿越
- 默认禁止访问：`~/.ssh`、`~/.config`、系统目录、Keychain
- 允许访问：workspace 内的源代码与配置

## 6. 回滚与恢复
- 在 apply patch 前自动创建文件快照备份（`~/.cofree/snapshots/`）
- Apply 失败时自动从快照回滚
- 快照机制不依赖 git HEAD，支持 untracked 文件
- 会话状态通过 SQLite checkpoint 持久化，重启后可恢复
