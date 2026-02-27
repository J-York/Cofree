# Cofree 技术架构

## 高层架构
- Frontend (React) <→ Tauri IPC <→ Rust Backend
- Agent Core: LangGraph State Machine (states: planning → executing → human_review → done)
- 模型调用：LiteLLM 统一入口（支持 OpenAI/Anthropic/xAI/Ollama）
- Guardrails：工具白名单 + 文件读写边界 + 强制审批门 + 审计日志（无 Docker，保持轻量）

> 重要：v0.1 的核心不是“强隔离 sandbox”，而是**可审计的 guardrails**。
> 任何写盘 / 命令执行 / git 写操作都必须经过 Human Approval Gate。

## 关键模块
- `src/orchestrator/`: LangGraph 工作流
- `src/agents/`: 每个专家独立 prompt + tool set
- `src/ui/`: 咖啡店风格组件（聊天、厨房、审批）

## 模块间契约（最小可用）
- Orchestrator 负责：状态机推进、审批门触发、审计日志写入、失败恢复
- Agents 负责：生成计划/patch/命令建议；不得绕过审批门直接产生副作用
- UI 负责：展示状态、承接 interrupt 审批、展示 diff/日志/错误

## Diff & 审批架构（v0.1）
- Diff 计算：`jsdiff`（或等价算法库）
- Diff 渲染：`diff2html` 并排只读视图
- 审批粒度：file 级为必选；hunk 级为可选增强
- Monaco Diff：后续升级项（当需要编辑/合并能力时）

## LangGraph HITL（Human-in-the-loop）建议
- 使用 `interrupt()` 实现审批节点暂停；使用 `Command(resume=...)` 恢复。
- 使用 SQLite checkpointer（如 `SqliteSaver`）实现本地会话持久化与可恢复。
- 规则：`interrupt()` 前避免不可逆副作用（因为恢复时节点会重新执行）。
