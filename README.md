# Cofree

> **本地优先的 AI 编程助手**——你提需求、看审批、做验收，AI 负责读代码、生成 patch、执行命令。

[![Version](https://img.shields.io/badge/version-0.0.9-blue)](package.json)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)](docs/BUILD.md)

---

## 产品定位

Cofree 是一个运行在用户本机的 **Tauri 2 桌面端 AI 编程工具**，面向独立开发者和小团队。

核心设计原则：

- **本地优先**：文件读写、patch 应用、命令执行全部发生在用户机器上，不需要远程代理服务。
- **人工审批在环（HITL）**：所有写盘和命令执行默认经过人工确认，AI 不会在没有授权的情况下修改代码或执行命令。
- **用户自带密钥（BYOK）**：对接用户自有的模型 API Key 或本地模型网关，应用本身不托管模型请求。
- **可观察、可恢复**：所有 LLM 请求和敏感动作写入本地审计日志，patch 应用前自动创建快照，工作流状态通过 SQLite checkpoint 持久化。

---

## 主要功能

### 对话与编排
- 聊天页支持流式回复、`<think>` 折叠、工具调用状态展示、错误提示。
- 内置 ChatAgent 角色：全栈工程师、代码审查员、架构师、QA 工程师，可按需选择或自定义。
- 主 Agent 可通过 `task` 工具把子任务委派给内部 `planner`、`coder`、`tester` 子 Agent，形成多 Agent 协作链路。
- 支持长对话自动压缩与上下文预算管理。

### 代码理解与上下文收集
- 工具集：`list_files`、`read_file`、`grep`、`glob`、`git_status`、`git_diff`、`diagnostics`、`fetch`。
- 读取工作区文件、目录枚举、内容搜索、Git 状态与差异。
- 支持 `.cofreerc` 配置文件，可声明 `systemPrompt`、`ignorePatterns`、`toolPermissions`、`contextFiles` 等。
- **动态工作区刷新**：会话过程中自动更新工作区概览和文件结构，确保 AI 始终看到最新的代码变更。

### 审批驱动的代码修改
- `propose_file_edit`：结构化编辑请求，生成 unified diff 并展示审批卡片。
- `propose_apply_patch`：直接提交 unified diff patch，同样走审批流。
- 用户可在 diff 预览视图中批准、拒绝或补充意见，支持批量审批。
- patch 应用前先做预检并创建文件快照，失败时自动回滚至快照状态。
- 审批通过并应用后，系统自动触发工作区诊断。

### 审批驱动的命令执行
- `propose_shell`：向用户展示完整 shell 命令与超时设置，用户确认后才执行。
- 覆盖构建、测试、git 写操作等所有命令类场景。
- 执行后展示 stdout / stderr / exit code。
- Rust 后端对灾难性命令模式（`rm -rf /`、`mkfs`、`shutdown` 等）做硬性拦截，即使审批通过也不执行。

### 可观察性与恢复
- **审计日志**：LLM 请求元数据与敏感动作日志在本地持久化，可在控制台页导出 JSON / CSV。
- **Checkpoint 恢复**：SQLite 存储工作流检查点，在中断后可继续执行。
- **文件快照**：patch 失败时从 `~/.cofree/snapshots/` 自动回滚，不依赖 Git HEAD。
- 控制台页可查看工作流阶段、工具调用时间线、请求统计。

### 模型与连接管理
- 支持协议：`openai-chat-completions`、`openai-responses`、`anthropic-messages`。
- 支持多供应商、多模型配置，可手动维护或拉取模型列表。
- 可为不同 Agent 绑定固定模型，支持代理配置与"允许云模型"开关。
- API Key 通过 Rust 端加密存储至 `~/.cofree/`，文件权限 `0600`，不写入 `localStorage`。

---

## 工具权限体系

| 工具 | 默认权限 | 说明 |
|------|----------|------|
| `list_files` | `auto` | 列目录 |
| `read_file` | `auto` | 读取文件内容 |
| `grep` | `auto` | 内容搜索 |
| `glob` | `auto` | 文件模式匹配 |
| `git_status` | `auto` | 查看工作区状态 |
| `git_diff` | `auto` | 查看差异 |
| `diagnostics` | `auto` | 运行项目诊断 |
| `propose_file_edit` | `ask` | 生成 patch，需审批 |
| `propose_apply_patch` | `ask` | 应用 unified diff，需审批 |
| `propose_shell` | `ask` | 执行 shell 命令，需审批 |
| `fetch` | `ask` | 拉取 URL 内容，需审批 |
| `task` | 委派 | 委派给子 Agent |

所有默认权限可通过设置页或 `.cofreerc` 覆盖。

---

## `.cofreerc` 配置

在工作区根目录创建 `.cofreerc` 或 `.cofreerc.json` 文件可定制项目级别的行为：

```json
{
  "systemPrompt": "本项目使用 React 19 + TypeScript + Tauri 2.0",
  "ignorePatterns": ["node_modules", "dist", "target"],
  "contextFiles": ["README.md", "ARCHITECTURE.md"],
  "toolPermissions": {
    "propose_file_edit": "auto",
    "propose_shell": "ask"
  },
  "workspaceRefresh": {
    "enabled": true,
    "turnInterval": 20,
    "onFileChange": true
  }
}
```

**配置项说明：**
- `systemPrompt`: 追加到系统提示的自定义指令
- `ignorePatterns`: 排除的文件/目录模式（glob 格式）
- `contextFiles`: 会话开始时自动加载的关键文件列表
- `toolPermissions`: 覆盖默认工具权限
- `workspaceRefresh`: 工作区上下文动态刷新配置
  - `enabled`: 是否启用（默认 `true`）
  - `turnInterval`: 每隔多少轮次刷新（默认 `20`）
  - `onFileChange`: 文件修改后是否刷新（默认 `true`）

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | React 19 + TypeScript |
| 桌面运行时 | Tauri 2.0 |
| 后端语言 | Rust |
| 前端构建 | Vite 6 + pnpm |
| 测试工具 | Vitest |
| 本地存储 | localStorage + SQLite (checkpoints) |

---

## 快速开始

**前置条件**：Node.js、pnpm、Rust 工具链（参见 [Tauri 文档](https://v2.tauri.app/start/prerequisites/)）

```bash
# 安装依赖
pnpm install

# 本地开发（启动 Tauri 桌面应用）
pnpm tauri:dev

# 仅启动前端（Vite 开发服务器，端口 1420）
pnpm dev

# 运行测试
pnpm test
```

启动后在设置页完成以下配置：
1. 选择本地工作区目录。
2. 配置模型供应商、API Key（或本地模型网关地址）。
3. 按需选择 ChatAgent 角色和工具权限。

---

## 构建与发布

```bash
# 构建前端
pnpm build

# 构建 macOS 安装包（dmg + app）
pnpm tauri:build:mac

# 构建 Windows 安装包（msi + nsis）
pnpm tauri:build:win
```

发布流通过 GitHub Actions 自动化：推送形如 `v0.0.9` 的 tag 即可触发多平台构建矩阵（macOS Apple Silicon、macOS Intel、Windows x64），并上传 Release 产物与 updater 所需的 `latest.json`。

---

## 安全与隐私

- 文件操作、patch 应用、命令执行均在本地完成，不经过 Cofree 服务端。
- 模型请求会把必要上下文通过 HTTP 发往用户配置的模型端点，**不是完全离线**。
- 路径边界：后端对所有文件操作做 canonicalize 校验，禁止绝对路径与路径穿越。
- 命令黑名单：Rust 后端硬性拦截一组灾难性命令模式。
- `sendRelativePathOnly` 默认只向模型发送相对路径；`maxSnippetLines` 和 `maxContextTokens` 可限制上下文体量。

详见 [docs/SECURITY_PRIVACY.md](docs/SECURITY_PRIVACY.md) 和 [docs/GUARDRAILS.md](docs/GUARDRAILS.md)。

---

## 文档索引

| 文档 | 内容 |
|------|------|
| [docs/INDEX.md](docs/INDEX.md) | 文档总览与阅读建议 |
| [docs/PRD.md](docs/PRD.md) | 产品定位、核心页面、主流程、已实现能力 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 技术架构、前后端职责、工具调用流程 |
| [docs/GUARDRAILS.md](docs/GUARDRAILS.md) | 审批门、工具权限、路径边界、命令拦截 |
| [docs/SECURITY_PRIVACY.md](docs/SECURITY_PRIVACY.md) | 数据外发边界、API Key 存储、审计日志 |
| [docs/GIT_SUPPORT.md](docs/GIT_SUPPORT.md) | Git 读写能力与限制 |
| [docs/BUILD.md](docs/BUILD.md) | 本地开发、构建目标、发布流程 |

---

## License

[MIT](LICENSE)
