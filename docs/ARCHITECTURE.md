# Cofree 技术架构（v0.0.2 实际实现）

> 本文档描述截至 Milestone 4 完成后的**实际**技术架构。

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
- **编排核心**: 自研 TypeScript 工具调用循环（`planningService.ts`），支持 Sub-Agent 委派
- **模型调用**: 通过 LiteLLM 兼容接口统一访问（支持 OpenAI/Anthropic/xAI/Ollama）
- **Guardrails**: 工具 runtime guardrails + 文件读写边界 + 强制审批门 + 审计日志（无 Docker / 无 OS sandbox）

> v0.0.2 的核心不是"强隔离 sandbox"，而是**可审计的 guardrails**。
> 任何写盘 / 命令执行 / git 写操作都必须经过 Human Approval Gate（或配置为 auto 模式自动执行）。

## 编排架构（工具调用循环 + Sub-Agent 委派）

v0.0.2 采用**主 LLM 工具调用循环 + Sub-Agent 委派**架构：

1. 用户输入需求 → 系统 prompt + 运行时上下文注入
2. LLM 通过 native tool calling 调用可用工具（最多 50 轮，30 轮时触发效率警告）
3. 只读工具（read_file, list_files, git_status, git_diff, grep, glob, diagnostics, fetch）自动执行
4. 写操作工具（propose_file_edit, propose_apply_patch, propose_shell）根据权限配置生成待审批动作或自动执行
5. `task` 工具可将子任务委派给 Sub-Agent（planner/coder/tester），Sub-Agent 运行独立工具调用循环
6. 用户审批后才执行副作用（ask 模式），或自动执行（auto 模式）
7. 多交付物检测：自动检测用户请求的交付物数量，提醒 LLM 补齐缺失交付物
8. Post-patch 自动诊断：patch 应用成功后自动运行编译检查

### 工具调用状态机

```
┌─────────┐    ┌──────────┐    ┌──────────────┐    ┌──────┐
│Planning │───→│Executing │───→│Human_Review  │───→│ Done │
└─────────┘    └──────────┘    └──────────────┘    └──────┘
  (LLM 规划      (工具执行      (用户审批             (完成)
   + 工具调用)     生成动作)      Approve/Reject)
                    │
                    ▼
              ┌──────────┐
              │Sub-Agent │ (task 工具委派)
              │独立循环   │
              └──────────┘
```

### 工具权限系统

每个写操作工具可独立配置权限级别（`ToolPermissions`）：

| 权限级别 | 行为 |
|----------|------|
| `ask` | 生成待审批动作卡片，用户 Approve 后执行（默认） |
| `auto` | 跳过审批直接执行，结果直接返回给 LLM |

## 关键模块

```
src/
├── orchestrator/          # 编排核心
│   ├── types.ts           # 工作流状态与动作类型定义
│   ├── planningService.ts # LLM 工具调用循环 + Sub-Agent 委派（核心）
│   ├── hitlService.ts     # HITL 审批执行（approve/reject/comment）
│   ├── hitlContinuationMachine.ts # HITL 结束后续跑状态机（tool 回放 + 防循环）
│   ├── hitlContinuationController.ts # HITL 续跑控制器
│   ├── checkpointStore.ts # SQLite 会话检查点持久化
│   ├── planGuards.ts      # 动作验证 & guardrails
│   ├── actionInference.ts # 工具调用→动作类型推断
│   ├── readOnlyWorkspaceService.ts # 只读工作区访问层
│   └── mockOrchestrator.ts # 测试用 mock
├── agents/
│   └── defaultAgents.ts   # 角色定义（planner/coder/tester，支持 Sub-Agent 委派）
├── lib/
│   ├── litellm.ts         # LiteLLM provider/model 注册表 & 请求构建（含流式 SSE）
│   ├── settingsStore.ts   # 设置持久化（localStorage + macOS Keychain + ToolPermissions）
│   ├── auditLog.ts        # 审计日志（LLM 请求 + 敏感动作 + JSON/CSV 导出）
│   ├── chatHistoryStore.ts# 对话历史持久化
│   ├── sessionContext.ts  # 会话上下文（工作流状态 + 工具追踪 + 请求统计）
│   ├── errorClassifier.ts # 错误分类（auth/network/patch_conflict/workspace/llm/unknown）
│   └── redaction.ts       # 敏感数据脱敏
└── ui/
    ├── pages/
    │   ├── ChatPage.tsx   # 主对话界面 + HITL 审批 UI
    │   ├── SettingsPage.tsx # 设置页
    │   └── KitchenPage.tsx  # 厨房仪表盘（工作流状态/统计/工具追踪/审计日志）
    ├── components/
    │   ├── NavTabs.tsx    # 导航侧栏
    │   ├── DiffViewer.tsx # Diff 预览（inline + split 双视图，文件级折叠/展开）
    │   ├── ShellResultDisplay.tsx # Shell 执行结果展示
    │   └── ErrorBanner.tsx # 分类错误提示（重试/详情展开）
    └── utils/
        └── chatUtils.ts   # 聊天 UI 工具函数

src-tauri/src/
└── main.rs               # Rust 后端：Tauri 命令处理层
```

## 模块间契约

- **Orchestrator** 负责：工具调用循环、审批门触发、审计日志写入、checkpoint 持久化
- **Rust Backend** 负责：文件系统操作（带边界校验）、patch 应用/回滚、shell 执行、git 操作、安全密钥存储
- **UI** 负责：展示工作流状态、承接审批交互、展示 diff 预览/日志/错误

## 审批门架构（v0.0.2 实际）

v0.0.2 存在**两类**审批门（非三类），每个门可通过 `ToolPermissions` 配置为 `ask`（默认，需审批）或 `auto`（自动执行）：

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

## Diff 渲染架构（v0.0.2）
- 独立 `DiffViewer` 组件（`src/ui/components/DiffViewer.tsx`）
- 支持 **inline**（行内）和 **split**（并排）双视图模式切换
- 基于 unified diff 格式解析，按行着色（+绿/-红），显示行号
- 文件级折叠/展开，统计面板（files/additions/deletions/hunks）
- 审批粒度：action 级（每个 patch 作为整体审批），支持批量审批（全部批准/全部拒绝）
- 未使用第三方 diff 渲染库（jsdiff / diff2html）

## 错误处理架构（v0.0.2）
- 独立 `ErrorBanner` 组件（`src/ui/components/ErrorBanner.tsx`）
- `errorClassifier.ts` 将错误分为 6 类：`auth_error`、`network_timeout`、`patch_conflict`、`workspace_error`、`llm_failure`、`unknown`
- 每类错误提供：标题、消息、指导建议、是否可重试
- 支持展开查看原始错误详情

## 数据持久化

```
Frontend (React)
    ↓
├── localStorage
│   ├── settings（不含 API Key，含 ToolPermissions）
│   ├── chat history
│   └── audit logs（≤200 条/类型，支持 JSON/CSV 导出）
│
├── macOS Keychain → API Key 安全存储
│
├── React Context (sessionContext.ts)
│   ├── workflowPhase（工作流状态）
│   ├── toolTraces（工具调用追踪）
│   └── requestSummaries（LLM 请求统计）
│
└── SQLite (via Tauri → ~/.cofree/checkpoints.db)
    └── workflow checkpoint（会话恢复 + HITL 续跑记忆）

Filesystem
└── ~/.cofree/snapshots/ → 文件快照备份（回滚用）
```

## Sub-Agent 委派架构（v0.0.2）

通过 `task` 工具支持将子任务委派给专业 Sub-Agent：

| 角色 | 专长 | 最大轮次 |
|------|------|---------|
| `planner` | 需求分析、架构设计、任务拆解 | 20 |
| `coder` | 代码实现、文件编辑 | 20 |
| `tester` | 测试验证、诊断分析 | 20 |

- Sub-Agent 运行独立的工具调用循环，继承当前 workspace 和工具权限
- Sub-Agent 不能嵌套调用 `task` 工具，避免循环委派
- Sub-Agent 的 proposed actions 会被收集并返回给主循环

## 可用工具集（v0.0.2）

| 工具 | 类型 | 说明 |
|------|------|------|
| `list_files` | 只读 | 列出目录内容 |
| `read_file` | 只读 | 读取文件内容（支持行范围分段读取） |
| `git_status` | 只读 | 查看 git 状态 |
| `git_diff` | 只读 | 查看 git diff |
| `grep` | 只读 | 正则表达式搜索文件内容（v0.0.2 新增） |
| `glob` | 只读 | 文件模式匹配搜索（v0.0.2 新增） |
| `diagnostics` | 只读 | 编译诊断（自动检测 TypeScript/Rust/Python/Go）（v0.0.2 新增） |
| `fetch` | 只读 | URL 内容获取（白名单域名限制）（v0.0.2 新增） |
| `propose_file_edit` | Gate A | 结构化文件编辑（replace/insert/delete/create），系统生成 patch |
| `propose_apply_patch` | Gate A | 提交 raw unified diff patch |
| `propose_shell` | Gate B | 提交 shell 命令（含 git 操作） |
| `task` | 委派 | 委派子任务给 Sub-Agent（planner/coder/tester）（v0.0.2 新增） |

## 安全边界

1. **路径校验**: 禁止 `..` 路径穿越，所有操作限定 workspace 内
2. **灾难命令拦截**: 硬拦截 `rm -rf /`、`mkfs`、`shutdown`、`reboot`、fork bomb
3. **HITL 审批**: 写操作默认需人类审批（可通过 `ToolPermissions` 配置为 auto）
4. **审计追踪**: 所有敏感动作写入审计日志（含时间、执行者、结果），支持 JSON/CSV 导出
5. **密钥隔离**: API Key 存储在 macOS Keychain，不进入 localStorage 或 git
6. **URL 白名单**: `fetch` 工具仅允许访问白名单域名（github.com, docs.rs, npmjs.com 等）

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
