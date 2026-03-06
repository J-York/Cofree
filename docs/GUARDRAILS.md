# Cofree Guardrails（v0.0.7）

本文件定义当前版本如何控制模型的本地副作用。

## 1. Guardrails 的目标

当前 guardrails 主要解决四件事：

1. 限制模型访问范围在用户选择的工作区内。
2. 让写盘和命令执行默认经过人工审批。
3. 记录敏感动作并保留恢复手段。
4. 在后端对明显危险的命令和非法路径做硬拦截。

## 2. 审批门

当前只有两类审批门。

### 2.1 Gate A：Patch / 写盘
- 工具：`propose_file_edit`、`propose_apply_patch`
- 输入：unified diff patch
- 用户可见内容：diff 预览、结构化摘要、审批按钮
- 执行前动作：patch 预检、快照创建
- 失败处理：应用失败时从快照回滚

### 2.2 Gate B：Shell / Git 写操作
- 工具：`propose_shell`
- 输入：完整 shell 命令
- 覆盖范围：构建、测试、删除、Git 写操作等
- 用户可见内容：完整命令文本、超时设置、审批按钮
- 执行结果：stdout、stderr、exit code、超时状态

Git 写操作没有单独的第三类审批门，而是统一走 shell 审批。

## 3. 默认工具权限

| 工具 | 默认权限 |
|------|----------|
| `list_files` | `auto` |
| `read_file` | `auto` |
| `grep` | `auto` |
| `glob` | `auto` |
| `git_status` | `auto` |
| `git_diff` | `auto` |
| `diagnostics` | `auto` |
| `propose_file_edit` | `ask` |
| `propose_apply_patch` | `ask` |
| `propose_shell` | `ask` |
| `fetch` | `ask` |

说明：
- `task` 是委派工具，不直接执行本地副作用。
- 权限可由设置页和 `.cofreerc` 覆盖。

## 4. 路径边界

后端当前执行这些校验：

- 禁止绝对路径。
- 禁止 `..` 路径穿越。
- 目标文件 canonicalize 后必须仍位于工作区内。
- 工作区路径必须存在且是目录。

## 5. 命令执行边界

Rust 后端会硬拦截一组灾难性模式，包括但不限于：

- `rm -rf /` 及类似变体
- `mkfs`
- `shutdown`
- `reboot`
- fork bomb 模式

这类命令即使经过审批也不会执行。

## 6. 回滚与恢复

### 6.1 Patch 回滚
- patch 应用前会创建文件快照。
- 快照位于 `~/.cofree/snapshots/`。
- 回滚不依赖 Git HEAD，能覆盖未跟踪文件。

### 6.2 工作流恢复
- checkpoint 保存在 `~/.cofree/checkpoints.db`。
- 应用重启后可恢复最近工作流状态。

## 7. 当前 guardrails 不包含的内容

以下能力不是当前 guardrails 体系的一部分：

- OS 级强隔离沙箱
- 全局网络访问白名单
- 基于策略引擎的细粒度命令审计 DSL
- 对所有 Git 场景的安全兜底

因此，当前安全模型的重点始终是：**用户看见、用户批准、后端校验、失败可回滚**。
