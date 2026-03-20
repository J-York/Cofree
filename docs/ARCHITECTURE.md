# Cofree 技术架构（v0.0.9）

本文档只描述当前仓库已经落地的桌面端架构。

## 1. 高层结构

```
┌────────────────────────────────────────────────────┐
│                 Tauri Desktop App                  │
│                                                    │
│  React + TypeScript Frontend                       │
│  ├─ ChatPage                                       │
│  ├─ SettingsPage                                   │
│  ├─ KitchenPage                                    │
│  └─ planningService / hitlService                  │
│                │                                   │
│                │ Tauri invoke                      │
│                ▼                                   │
│  Rust Backend                                      │
│  ├─ workspace file ops                             │
│  ├─ git status / diff                              │
│  ├─ patch check / apply / rollback                 │
│  ├─ shell execution                                │
│  ├─ diagnostics / fetch                            │
│  ├─ checkpoint / snapshot storage                  │
│  └─ secure API key store                           │
│                │                                   │
│                ▼                                   │
│  Model HTTP Endpoints / LiteLLM-compatible APIs    │
└────────────────────────────────────────────────────┘
```

架构核心不是“远程代理服务”，而是：

- 前端负责交互、编排、审批与状态展示。
- Rust 端负责本地副作用执行与边界校验。
- 模型请求通过 HTTP 直接发往用户配置的模型服务地址。

## 2. 前端架构

### 2.1 页面层
- `ChatPage`：对话、流式输出、待审批动作、diff 预览、shell 结果。
- `SettingsPage`：工作区、模型、代理、工具权限、Agent 配置。
- `KitchenPage`：工作流阶段、统计、工具追踪、审计导出。

### 2.2 编排层
- `planningService.ts` 是核心编排入口。
- 负责组装系统提示词、会话上下文、工具定义和模型请求。
- 管理工具调用循环、审批挂起、checkpoint、继续执行、自动诊断。

### 2.3 Agent 层
- 顶层 ChatAgent 面向用户选择（含内置「专家组接待」`agent-concierge`，见 [EXPERT_PANEL.md](./EXPERT_PANEL.md)）。
- `task` 工具可把子任务委派给 `planner`、`coder`、`tester` 等子角色，或按预置 Team ID 跑流水线；工具 schema 中的 `team` 枚举会按当前 Agent 的 `allowedSubAgents` 过滤。
- 子 Agent 运行独立工具循环，但仍在同一工作区和同一 guardrails 体系内。

### 2.4 持久化与状态
- 设置、对话列表、审计日志主要保存在 `localStorage`。
- 对话按工作区做 key namespacing，避免不同仓库之间混用。
- `sessionContext` 保存当前工作流阶段、工具追踪、请求统计等运行态信息。

## 3. Rust 后端职责

Rust 命令层通过 Tauri `invoke()` 暴露本地能力，主要包括：

- 工作区路径校验、文件读取、目录枚举。
- Git 状态与 diff 查询。
- patch 预检、应用、快照与回滚。
- shell 执行与超时控制。
- 自动诊断。
- URL 拉取。
- SQLite checkpoint 读写。
- 安全 API Key 存储。

## 4. 工具调用架构

### 4.1 当前工具集

| 工具 | 类型 | 用途 |
|------|------|------|
| `list_files` | 只读 | 列目录 |
| `read_file` | 只读 | 读取文件内容 |
| `git_status` | 只读 | 查看工作区状态 |
| `git_diff` | 只读 | 查看差异 |
| `grep` | 只读 | 内容搜索 |
| `glob` | 只读 | 文件模式匹配 |
| `diagnostics` | 只读 | 运行项目诊断 |
| `fetch` | 只读 | 拉取 URL 内容 |
| `propose_file_edit` | 需审批/可自动 | 结构化编辑并生成 patch |
| `propose_apply_patch` | 需审批/可自动 | 直接提交 unified diff |
| `propose_shell` | 需审批/可自动 | 提交 shell 命令 |
| `task` | 委派 | 委派给子 Agent |

### 4.2 调用流程
1. 用户输入任务。
2. 编排层把当前工作区上下文、会话摘要、Agent 设定注入模型请求。
3. 模型调用工具。
4. 只读工具直接执行；写工具根据权限进入审批或直接执行。
5. patch 应用后触发自动诊断。
6. 工具结果和最终消息回写到会话与追踪状态。

### 4.3 工具权限
- `list_files`、`read_file`、`grep`、`glob`、`git_status`、`git_diff`、`diagnostics` 默认 `auto`。
- `propose_file_edit`、`propose_apply_patch`、`propose_shell` 默认 `ask`。
- `fetch` 当前默认也是 `ask`。
- 权限可在设置页或 `.cofreerc` 覆盖。

## 5. 审批与执行链路

### 5.1 Patch 链路
1. 模型生成结构化编辑或 raw patch。
2. 前端展示 diff 预览。
3. Rust 端先做 `git apply --check` 预检。
4. 通过后创建快照并应用 patch。
5. 应用失败时从快照回滚。
6. 成功后执行自动诊断并把结果反馈给编排层。

### 5.2 Shell 链路
1. 模型生成完整 shell 命令。
2. 用户审批命令文本。
3. Rust 端在工作区目录中执行命令。
4. 返回 stdout、stderr、exit code、超时结果。

## 6. 当前运行态阶段

工作流主要围绕这些阶段变化：

- `idle`
- `planning`
- `executing`
- `human_review`
- `done`
- `error`

控制台页会直接展示这些阶段及工具调用时间线。

## 7. 数据存储

### 7.1 浏览器侧
- `localStorage`：设置、会话元数据、审计日志。
- 会话数据按工作区 hash 做隔离。

### 7.2 本地文件系统
- `~/.cofree/checkpoints.db`：SQLite checkpoint。
- `~/.cofree/snapshots/`：patch 回滚快照。
- `~/.cofree/keystore.key` 与 `~/.cofree/keystore.json`：加密 API Key 存储。

## 8. 诊断与外部请求

### 8.1 自动诊断
- TypeScript 项目：`npx tsc --noEmit --pretty false`
- Rust 项目：`cargo check --message-format=short`
- Python 项目：对变更文件执行 `python3 -m py_compile`

### 8.2 URL 拉取
- `fetch` 当前按任意可访问 URL 请求。
- 后端会限制最大响应大小，但没有内置域名白名单。
- 若要限制外发范围，应通过工具权限、模型配置和使用约束控制。

## 9. 更新与分发

- 桌面端已接入 updater 插件。
- 非开发模式下会自动检查 GitHub Release 更新。
- 下载完成后可安装并重启应用。

## 10. 当前架构边界

以下说法不符合当前实现：

- “前后端分离服务架构”
- “API Key 存在系统钥匙串中”
- “fetch 仅允许白名单域名”
- “工作区必须是 Git 仓库才能进入应用”

这些都已经与当前代码不一致，不应继续出现在其他文档中。
