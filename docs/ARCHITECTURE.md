# Cofree 技术架构（v0.1 实际实现）

> 本文档描述截至 Milestone 3 完成后的**实际**技术架构，而非初期设想。

## 高层架构

```
┌───────────────────────────────────────────────────┐
│                   Tauri 2.0 Desktop Shell          │
│  ┌─────────────────┐     ┌───────────────────────┐ │
│  │  React 19 前端   │ IPC │   Rust 后端 (main.rs)  │ │
│  │                 │◄───►│                       │ │
│  │  ChatPage       │     │  Workspace Ops        │ │
│  │  SettingsPage   │     │  Git Ops (git2)       │ │
│  │  KitchenPage    │     │  Patch Apply/Rollback │ │
│  │                 │     │  Shell Execution      │ │
│  │  Orchestrator   │     │  Snapshot/Checkpoint  │ │
│  │  (TS tool loop) │     │  Secure Key Storage   │ │
│  └─────────────────┘     └───────────────────────┘ │
│           │                                        │
│           ▼                                        │
│  ┌─────────────────┐                               │
│  │  LiteLLM / 模型  │ (OpenAI/Anthropic/xAI/Ollama)│
│  │  via HTTP API   │                               │
│  └─────────────────┘                               │
└───────────────────────────────────────────────────┘
```

- **Frontend (React 19)** ←Tauri IPC→ **Rust Backend**
- **编排核心**: 自研 TypeScript 工具调用循环（`planningService.ts`），非 LangGraph
- **模型调用**: 通过 LiteLLM 兼容接口统一访问（支持 OpenAI/Anthropic/xAI/Ollama）
- **Guardrails**: 工具 runtime guardrails + 文件读写边界 + 强制审批门 + 审计日志（无 Docker / 无 OS sandbox）

> v0.1 的核心不是"强隔离 sandbox"，而是**可审计的 guardrails**。
> 任何写盘 / 命令执行 / git 写操作都必须经过 Human Approval Gate。

## 编排架构（单 LLM 工具循环）

v0.1 采用**单 LLM 工具调用循环**而非多 Agent 并行编排。这与业界主流 Agent Coding 工具（Cursor、Claude Code、Aider、Cline）的实践一致：

1. 用户输入需求 → 系统 prompt + 运行时上下文注入
2. LLM 通过 native tool calling 调用可用工具（最多 15 轮）
3. 只读工具（read_file, list_files, git_status, git_diff）自动执行
4. 写操作工具（propose_file_edit, propose_apply_patch, propose_shell）生成待审批动作
5. 用户审批后才执行副作用

### 工具调用状态机

```
┌─────────┐    ┌──────────┐    ┌──────────────┐    ┌──────┐
│Planning │───→│Executing │───→│Human_Review  │───→│ Done │
└─────────┘    └──────────┘    └──────────────┘    └──────┘
  (LLM 规划      (工具执行      (用户审批             (完成)
   + 工具调用)     生成动作)      Approve/Reject)
```

### 动态工具路由

系统根据用户意图自动选择暴露给 LLM 的工具集：

| 路由模式 | 触发条件 | 暴露的工具 |
|----------|---------|-----------|
| `read_only` | 无写入/命令意图 | list_files, read_file, git_status, git_diff |
| `structured_edit` | 代码修改意图 | 上述 + propose_file_edit, propose_apply_patch, propose_shell |
| `explicit_patch` | 显式 patch/diff 意图 | 同上 |
| `shell_command` | 命令/git 执行意图 | 同上 |
| `delete_file` | 整文件删除意图 | 同上 |
| `summary_only` | 审批结果汇报阶段 | 无工具 |

## 关键模块

```
src/
├── orchestrator/          # 编排核心
│   ├── types.ts           # 工作流状态与动作类型定义
│   ├── planningService.ts # LLM 工具调用循环（核心 ~2100 行）
│   ├── hitlService.ts     # HITL 审批执行（approve/reject/comment）
│   ├── hitlContinuationMachine.ts # HITL 结束后续跑状态机（tool 回放 + 防循环）
│   ├── checkpointStore.ts # SQLite 会话检查点持久化
│   ├── planGuards.ts      # 动作验证 & guardrails
│   ├── actionInference.ts # 工具调用→动作类型推断
│   └── readOnlyWorkspaceService.ts # 只读工作区访问层
├── agents/
│   └── defaultAgents.ts   # 角色定义（元数据标签，非独立 Agent）
├── lib/
│   ├── litellm.ts         # LiteLLM provider/model 注册表 & 请求构建
│   ├── settingsStore.ts   # 设置持久化（localStorage + macOS Keychain）
│   ├── auditLog.ts        # 审计日志（LLM 请求 + 敏感动作）
│   ├── chatHistoryStore.ts# 对话历史持久化
│   └── redaction.ts       # 敏感数据脱敏
└── ui/
    ├── pages/
    │   ├── ChatPage.tsx   # 主对话界面 + HITL 审批 UI + diff 预览
    │   ├── SettingsPage.tsx # 设置页
    │   └── KitchenPage.tsx  # 占位页
    └── components/
        └── NavTabs.tsx    # 导航侧栏

src-tauri/src/
└── main.rs               # Rust 后端：Tauri 命令处理层 (~1300 行)
```

## 模块间契约

- **Orchestrator** 负责：工具调用循环、审批门触发、审计日志写入、checkpoint 持久化
- **Rust Backend** 负责：文件系统操作（带边界校验）、patch 应用/回滚、shell 执行、git 操作、安全密钥存储
- **UI** 负责：展示工作流状态、承接审批交互、展示 diff 预览/日志/错误

## 审批门架构（v0.1 实际）

v0.1 存在**两类**审批门（非三类）：

### Gate A：Apply Patch（写盘）
- 输入：unified diff patch（由 `propose_file_edit` 结构化生成或 `propose_apply_patch` 直接提交）
- 流程：预检（check_workspace_patch）→ 快照备份 → 审批 → 应用 → 失败自动回滚
- UI：彩色 diff 预览 + Approve/Reject/Comment

### Gate B：Shell Execution（命令 + Git 写操作）
- 输入：完整 shell 命令字符串（`propose_shell`）
- 覆盖范围：构建、测试、文件删除、git add/commit/branch 等所有命令
- 安全模型："人类审批完整命令" + 灾难性命令硬拦截
- UI：命令预览 + 超时设置 + Approve/Reject

> 注：初期设想的 Gate C（Git Write 独立门）已被 Gate B 统一覆盖。Git 写操作通过 `propose_shell`（如 `git commit -m "..."`）处理。

## Diff 渲染架构（v0.1）
- 自研彩色 diff 预览组件，内嵌在 ChatPage.tsx
- 基于 unified diff 格式解析，按行着色（+绿/-红）
- 审批粒度：action 级（每个 patch 作为整体审批）
- 未使用第三方 diff 渲染库（jsdiff / diff2html）

## 数据持久化

```
Frontend (React)
    ↓
├── localStorage
│   ├── settings（不含 API Key）
│   ├── chat history
│   └── audit logs（≤200 条/类型）
│
├── macOS Keychain → API Key 安全存储
│
└── SQLite (via Tauri → ~/.cofree/checkpoints.db)
    └── workflow checkpoint（会话恢复）

Filesystem
└── ~/.cofree/snapshots/ → 文件快照备份（回滚用）
```

## 安全边界

1. **路径校验**: 禁止 `..` 路径穿越，所有操作限定 workspace 内
2. **灾难命令拦截**: 硬拦截 `rm -rf /`、`mkfs`、`shutdown`、`reboot`、fork bomb
3. **HITL 审批**: 所有写操作必须经人类审批
4. **审计追踪**: 所有敏感动作写入审计日志（含时间、执行者、结果）
5. **密钥隔离**: API Key 存储在 macOS Keychain，不进入 localStorage 或 git

## 技术栈

| 层 | 技术 | 版本 |
|---|------|------|
| 前端框架 | React | 19.0.0 |
| 构建工具 | Vite | 6.0.0 |
| 前端语言 | TypeScript | 5.6.0 |
| 桌面框架 | Tauri | 2.0 |
| 后端语言 | Rust | 2021 edition, ≥1.77 |
| 数据库 | SQLite | via rusqlite 0.31 |
| HTTP 客户端 | reqwest | 0.12 |
| Git 库 | git2 | 0.18 |
| Markdown 渲染 | react-markdown | 10.1.0 |
| 构建目标 | macOS (dmg/app), Windows (msi/nsis) | - |
| 包管理器 | pnpm | - |
