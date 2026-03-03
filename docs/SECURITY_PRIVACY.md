# Cofree Security & Privacy（v0.0.2）— 实际实现修订版

本文件把"本地优先 + 自带 API Key"落实为可验证的安全与隐私规范。

## 1. 术语
- **本地执行（Local Execution）**：文件读取、patch 生成、diff 渲染、git 操作、日志存储都在用户机器本地完成。
- **模型调用（LLM Request）**：向模型提供商（或本地模型）发送请求并接收响应。
- **数据外泄（Data Egress）**：任何离开本机的内容（包括代码片段、diff、文件路径、命令输出、错误栈等）。

## 2. v0.0.2 的隐私承诺（已实现）
1) Cofree 不会在未经用户同意的情况下上传代码仓库。
2) 所有"敏感动作"（写盘/命令/git 写操作）必须经过审批门。
3) 所有模型调用记录到本地审计日志（不记录 API Key；对内容做截断/摘要）。

## 3. Data Egress Policy

### 3.1 允许发送的数据类型（默认）
- 用户输入的自然语言需求
- 为完成任务所需的最小代码上下文（片段级），受 `maxSnippetLines` 设置限制
- 结构化工具调用意图（不包含秘密）

### 3.2 默认禁止发送的数据类型
- `.env`、密钥文件、token、证书、SSH key、Keychain 内容
- 整个仓库打包上传
- 大体量文件内容（除非用户显式批准）

### 3.3 用户控制（已实现）
用户可在设置页选择：
- ✅ 仅使用本地模型 / 允许云模型（`allowCloudModels` 开关）
- ✅ 发送代码片段的最大长度：200/500/2000 行（`maxSnippetLines`）
- ✅ 是否允许发送文件路径（`sendRelativePathOnly`，默认只发送相对路径）
- ✅ 上下文 token 上限配置（`maxContextTokens`）

## 4. API Key 存储（已实现）
- ✅ API Key 存储在 **macOS Keychain**（通过 Tauri Rust 后端的 `security` 命令）
- ✅ 不写入 localStorage 或 git 可跟踪文件
- ✅ UI 展示时做掩码处理（`****...****`）

## 5. 审计日志（Audit Log）

### 5.1 已实现的记录事件
- **LLM 请求**：provider、model、时间、输入/输出长度、请求 ID
- **敏感动作**：动作 ID、类型（apply_patch/shell）、状态、开始/结束时间、执行者、原因、工作区路径、详情

### 5.2 日志存储
- 存储位置：localStorage
- 容量限制：每类最多 200 条记录
- 不记录 API Key
- 内容字段做截断处理
- 导出功能已实现：厨房页一键导出 JSON/CSV（通过 Tauri `save_file_dialog`）

## 6. 安全边界声明（v0.0.2）
- v0.0.2 的"安全"主要来自 guardrails 与审批门，不等同于强隔离 sandbox。
- v0.0.2 新增工具权限系统（`ToolPermissions`）：用户可将特定工具配置为 `auto` 模式跳过审批，此时风险由用户配置承担。
- 若用户允许执行命令或写盘，风险由用户审批承担；系统必须提供清晰的预览与提示。
- `fetch` 工具仅允许访问白名单域名，防止数据外泄。
- Rust 后端提供路径边界校验和灾难命令拦截作为最后防线。
