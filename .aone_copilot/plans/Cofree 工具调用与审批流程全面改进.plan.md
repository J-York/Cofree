### Cofree 工具调用与审批流程全面改进 ###
对 Cofree 的 LLM 工具体系、审批流程、上下文管理和 Agent 架构进行全面升级，从 P0 到 P3 共 8 项改进，涵盖后端 Rust 命令、前端 TypeScript 工具定义/编排逻辑、设置 UI 和上下文管理。


## P0 - 核心能力补齐

### 1. 添加 grep 和 glob 搜索工具

**目标**：让 LLM 能快速定位代码，不再需要逐层 list_files + read_file 盲猜。

**1.1 Rust 后端 - 新增两个 Tauri 命令** (`src-tauri/src/main.rs`)

- 新增 `grep_workspace_files` 命令：
  - 参数：`workspace_path: String`, `pattern: String` (正则), `include_glob: Option<String>` (文件过滤，如 `*.ts`), `max_results: Option<usize>` (默认 50)
  - 实现：使用 `grep` crate 或直接调用系统 `grep -rn` / `rg`（优先检测 ripgrep 是否可用，回退到系统 grep）
  - 返回结构体 `GrepResult { matches: Vec<GrepMatch> }`，其中 `GrepMatch { file: String, line: usize, content: String }`
  - 安全校验：复用 `validate_workspace_path` 确保不越界

- 新增 `glob_workspace_files` 命令：
  - 参数：`workspace_path: String`, `pattern: String` (glob 模式，如 `**/*.tsx`), `max_results: Option<usize>` (默认 100)
  - 实现：使用 `glob` crate 遍历匹配文件，自动排除 `.git`、`node_modules`、`target` 等目录
  - 返回 `Vec<GlobEntry>` 其中 `GlobEntry { path: String, size: u64, modified: u64 }`

- 在 `run()` 的 `invoke_handler` 中注册这两个新命令

**1.2 前端 - 工具定义与执行** (`src/orchestrator/planningService.ts`)

- 在 `TOOL_DEFINITIONS` 数组中新增两个工具定义：
  - `grep`：description 说明支持正则搜索文件内容，参数包含 `pattern`(必填)、`include_glob`(可选)、`max_results`(可选)
  - `glob`：description 说明支持 glob 模式匹配文件路径，参数包含 `pattern`(必填)、`max_results`(可选)

- 在 `executeToolCall` 函数中新增两个工具的执行分支：
  - `grep`：调用 `invoke("grep_workspace_files", {...})`，返回匹配结果的 JSON
  - `glob`：调用 `invoke("glob_workspace_files", {...})`，返回匹配文件列表的 JSON

- 更新 `READ_ONLY_TOOL_NAMES` 常量，加入 `"grep"` 和 `"glob"`

**1.3 Agent 定义更新** (`src/agents/defaultAgents.ts`)

- `planner` 的 tools 数组加入 `"grep"`, `"glob"`
- `coder` 的 tools 数组加入 `"grep"`, `"glob"`
- `tester` 的 tools 数组加入 `"grep"`, `"glob"`

**1.4 System Prompt 更新** (`planningService.ts` 中的 `ASSISTANT_SYSTEM_PROMPT`)

- 在"文件读取策略"部分新增搜索策略说明：
  - 需要定位代码时优先使用 grep 搜索关键词，而非逐个文件阅读
  - 需要查找文件时优先使用 glob 匹配模式，而非逐层 list_files

---

### 2. 增加工具循环上限

**目标**：避免复杂任务被强制截断。

**修改文件**：`src/orchestrator/planningService.ts`

- 将 `MAX_TOOL_LOOP_TURNS` 从 `15` 改为 `50`
- 将 `MAX_AUTO_CONTINUE_ROUNDS_PER_PROMPT`（在 `ChatPage.tsx` 中）从 `5` 改为 `10`
- 在工具循环中增加"进度感知"：当循环超过 30 轮时，注入一条 system 消息提醒 LLM 注意效率，避免无限循环

---

## P1 - 审批流程优化

### 3. 支持批量审批

**目标**：减少审批中断次数，一次性批准/拒绝所有 pending 动作。

**3.1 新增批量操作函数** (`src/orchestrator/hitlService.ts`)

- 新增 `approveAllActions(plan, workspacePath)` 函数：遍历所有 `status === "pending"` 的动作，依次执行
- 新增 `rejectAllActions(plan, reason)` 函数：遍历所有 `status === "pending"` 的动作，全部拒绝

**3.2 UI 新增批量按钮** (`src/ui/pages/ChatPage.tsx` 的 `InlinePlan` 组件)

- 在动作列表上方新增两个按钮："全部批准" 和 "全部拒绝"
- 仅当有 2 个及以上 pending 动作时显示
- "全部批准"按钮点击后依次执行所有 pending 动作，执行过程中禁用所有按钮

---

### 4. 工具权限配置系统

**目标**：只读工具默认自动执行，写入工具默认需审批，用户可在设置中调整。

**4.1 扩展设置数据结构** (`src/lib/settingsStore.ts`)

- 在 `AppSettings` 接口中新增字段：
  ```typescript
  toolPermissions: {
    list_files: "auto" | "ask";
    read_file: "auto" | "ask";
    grep: "auto" | "ask";
    glob: "auto" | "ask";
    git_status: "auto" | "ask";
    git_diff: "auto" | "ask";
    propose_file_edit: "auto" | "ask";
    propose_apply_patch: "auto" | "ask";
    propose_shell: "auto" | "ask";
  };
  ```
- 默认值：只读工具全部 `"auto"`，`propose_*` 工具全部 `"ask"`

**4.2 修改工具执行逻辑** (`src/orchestrator/planningService.ts`)

- 修改 `executeToolCall` 函数：
  - 当工具的权限为 `"auto"` 时，`propose_file_edit` / `propose_apply_patch` / `propose_shell` 不再生成 `ActionProposal`，而是直接执行（调用 Tauri 后端的 apply_workspace_patch / run_shell_command）
  - 当权限为 `"ask"` 时，保持现有的 propose + HITL 审批流程
- 修改 `runNativeToolCallingLoop`：接收 `toolPermissions` 参数，传递给 `executeToolCall`

**4.3 设置页面 UI** (`src/ui/pages/SettingsPage.tsx`)

- 新增"工具权限"设置卡片，包含一个表格：
  - 左列：工具名称 + 简短描述
  - 右列：下拉选择 "自动执行" / "需要审批"
  - 分为"只读工具"和"写入工具"两组，视觉上有分隔
- 底部增加安全提示文案："将写入工具设为自动执行意味着 LLM 可以直接修改文件和执行命令，请确保你信任当前使用的模型。"

**4.4 去掉关键词路由** (`src/orchestrator/planningService.ts`)

- 修改 `inferToolRoutingPolicy`：不再根据用户意图关键词决定暴露哪些工具
- 改为始终暴露所有工具（`TOOL_DEFINITIONS` 全集），权限控制交给 `toolPermissions`
- 删除 `WRITE_INTENT_HINTS`、`PATCH_INTENT_HINTS`、`COMMAND_INTENT_HINTS` 等关键词列表（保留 `actionInference.ts` 中的，那个用于 UI 提示，不影响工具暴露）
- 删除 `ToolRoutingMode` 和 `ToolRoutingPolicy` 类型，简化为直接返回所有工具名

---

## P2 - 上下文与反馈增强

### 5. 上下文摘要压缩

**目标**：用 LLM 生成对话摘要替代简单截断，保留关键信息。

**修改文件**：`src/orchestrator/planningService.ts`

- 修改 `sanitizeConversationHistory` 函数：
  - 当对话历史 token 估算超过 `maxContextTokens * 0.7` 时，触发摘要压缩
  - 将较早的消息（保留最近 5 轮）打包成一个摘要请求，调用 LLM 生成摘要
  - 摘要请求的 prompt：`"请简洁总结以下对话的关键信息，包括：用户的原始需求、已完成的工作、当前正在进行的任务、涉及的文件路径。"`
  - 将摘要结果作为一条 system 消息插入到对话历史开头，替代被压缩的消息
  - 增加一个缓存机制：同一个 session 中，如果对话历史没有变化，不重复生成摘要

- 新增 `requestSummary(messages, settings)` 辅助函数：
  - 使用当前配置的模型发送一个非流式请求
  - 不传入 tools（纯文本摘要）
  - 返回摘要文本

---

### 6. LSP 诊断反馈集成

**目标**：编辑文件后自动获取编译/类型检查反馈，让 LLM 能自动修复错误。

**6.1 Rust 后端 - 新增诊断命令** (`src-tauri/src/main.rs`)

- 新增 `check_workspace_diagnostics` 命令：
  - 参数：`workspace_path: String`, `file_paths: Vec<String>`
  - 实现策略（按优先级）：
    1. 检测项目类型，运行对应的 lint/check 命令（如 `tsc --noEmit` for TS, `cargo check` for Rust, `python -m py_compile` for Python）
    2. 捕获 stderr 输出，解析为结构化诊断信息
  - 返回 `Vec<DiagnosticEntry>` 其中 `DiagnosticEntry { file: String, line: usize, severity: String, message: String }`
  - 超时限制：30 秒

- 在 `run()` 的 `invoke_handler` 中注册

**6.2 前端 - 自动诊断反馈** (`src/orchestrator/planningService.ts`)

- 在 `propose_file_edit` 和 `propose_apply_patch` 工具执行成功后（权限为 auto 且直接执行的情况下），自动调用 `check_workspace_diagnostics`
- 如果有诊断错误，将错误信息作为 tool result 的一部分返回给 LLM，格式如：
  ```
  {"ok": true, ..., "diagnostics": [{"file": "src/foo.ts", "line": 10, "message": "..."}]}
  ```
- 在 System Prompt 中增加说明：当工具返回 diagnostics 时，应优先修复这些错误

---

## P3 - 架构增强

### 7. Sub-Agent 支持

**目标**：允许主 Agent 委派子任务给专门的 Sub-Agent。

**7.1 新增 Task 工具定义** (`src/orchestrator/planningService.ts`)

- 在 `TOOL_DEFINITIONS` 中新增 `task` 工具：
  - 参数：`description`(必填), `prompt`(必填), `agent_type`(必填，枚举值来自 `defaultAgents.ts` 的 AgentRole)
  - description 说明可用的 agent 类型及其能力

**7.2 Sub-Agent 执行逻辑** (`src/orchestrator/planningService.ts`)

- 新增 `executeSubAgentTask` 函数：
  - 创建一个独立的消息上下文（不共享主对话历史）
  - 根据 `agent_type` 选择对应的 system prompt 和工具集
  - 调用 `runNativeToolCallingLoop` 执行子任务
  - 返回子任务的最终回复文本作为 tool result

**7.3 Agent 定义扩展** (`src/agents/defaultAgents.ts`)

- 新增 `reviewer` 角色：只读工具 + 代码审查专用 prompt
- 为每个 AgentRole 增加 `systemPrompt` 字段，存储角色专属的 system prompt
- 主 Agent（当前的 ASSISTANT_SYSTEM_PROMPT）的 tools 中加入 `"task"`

---

### 8. 持久化保存时保留工具调用详情

**目标**：确保 localStorage 持久化的对话历史包含完整的工具调用信息，恢复会话时 LLM 能获得完整上下文。

**修改文件**：`src/lib/chatHistoryStore.ts`

- 修改 `saveChatHistory` 函数：
  - 当前实现会将 `plan` 设为 null、`toolTrace` 设为空数组，导致恢复后丢失工具调用信息
  - 改为保留 `tool_calls`、`tool_call_id`、`name` 字段（这些已经在保存了）
  - 对 `toolTrace` 做精简保留：只保留 `name`、`status`、`resultPreview` 前 200 字符
  - 对 `plan` 中的 `proposedActions` 做精简保留：只保留 `type`、`status`、`executed`、`executionResult.success`

---

## 实施顺序建议

1. **P0-1** grep/glob 搜索工具（后端 + 前端 + prompt）
2. **P0-2** 增加工具循环上限
3. **P1-4** 工具权限配置系统（含去掉关键词路由）
4. **P1-3** 批量审批
5. **P2-5** 上下文摘要压缩
6. **P2-6** LSP 诊断反馈
7. **P3-7** Sub-Agent 支持
8. **P3-8** 持久化保留工具调用详情

每项改进完成后应运行 `pnpm tauri dev` 验证功能正常，确保不引入回归。


updateAtTime: 2026/3/3 10:49:54

planId: 95566188-0962-4eab-b638-d928dca9eedb