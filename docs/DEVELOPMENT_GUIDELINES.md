# Cofree 开发规范（AI & Human 必须严格遵守）— v0.0.2 修订版

## 1. 进度同步机制（最重要）
- **核心文件**：根目录 `PROGRESS.md`
- **文件头注释**：鼓励在源代码文件顶部添加以下注释块（非强制，部分文件已有）：

```ts
/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/types.ts
 * Milestone: 2
 * Status: Completed
 * Last Modified: 2026-03-01
 * Description: 工作流状态与动作类型定义
 */
```

## 2. 文档优先（Docs-as-Code）
v0.1 的"可控自主"依赖文档约束。任何会影响安全边界/数据外泄/交付流程的改动，都必须先更新对应文档：
- 范围与黄金路径：`docs/MVP.md`
- 安全与隐私：`docs/SECURITY_PRIVACY.md`
- Guardrails 与审批门：`docs/GUARDRAILS.md`
- Git 支持范围：`docs/GIT_SUPPORT.md`

## 3. HITL（Human-in-the-loop）硬性规则

v0.0.2 使用**自研的 TypeScript 工具调用编排循环**（非 LangGraph）实现 HITL，支持 Sub-Agent 委派：

1) LLM 通过 `propose_*` 工具生成待审批动作，系统暂停等待用户审批（`ask` 模式）。
2) 若工具权限配置为 `auto` 模式，则跳过审批直接执行。
3) 审批前不执行任何副作用（写盘、命令、git 写操作）（`ask` 模式下）。
4) 审批状态通过 SQLite checkpoint 持久化，支持会话恢复。
5) 审批结果（approve/reject/comment）通过 `hitlService.ts` 处理，支持批量审批。
6) 审批完成后通过 `hitlContinuationController.ts` 自动续跑剩余任务。

## 4. 审批门（Approval Gates）必须覆盖的动作
以下动作一律视为"敏感动作"，必须经过 UI 审批门并写入审计日志：
- **Gate A**：写文件 / 删除文件内容 / 创建文件（通过 propose_file_edit 或 propose_apply_patch）
- **Gate B**：执行任何 shell 命令、git 写操作、文件删除（通过 propose_shell）

## 5. 术语一致性
- v0.0.2 使用 **Guardrails** 表述安全边界；不要在没有强隔离实现的前提下使用"Sandbox"误导。
- "100% 本地"必须同时参考 `docs/SECURITY_PRIVACY.md` 的 Data Egress Policy。
- 编排架构描述为"LLM 工具调用循环 + Sub-Agent 委派"，不使用"LangGraph"。
- 版本号使用 `v0.0.x` 格式（当前 v0.0.2），不使用 `v0.1`。
