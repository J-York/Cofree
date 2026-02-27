# Cofree 开发规范（AI & Human 必须严格遵守）

## 1. 进度同步机制（最重要）
- **核心文件**：根目录 `PROGRESS.md`
- **文件头注释**：每个源代码文件顶部必须有以下注释块（Claude 自动生成）：

```ts
/**
 * Cofree - AI Programming Cafe
 * File: src/components/ChatWindow.tsx
 * Milestone: 1
 * Task: 1.1
 * Status: In Progress | Completed | Review Needed
 * Owner: Claude-3.5-Sonnet
 * Last Modified: 2026-02-26
 * Description: 服务员聊天窗口组件
 */

```

## 2. 文档优先（Docs-as-Code）
v0.1 的“可控自主”依赖文档约束。任何会影响安全边界/数据外泄/交付流程的改动，都必须先更新对应文档：
- 范围与黄金路径：`docs/MVP.md`
- 安全与隐私：`docs/SECURITY_PRIVACY.md`
- Guardrails 与审批门：`docs/GUARDRAILS.md`
- Git 支持范围：`docs/GIT_SUPPORT.md`

## 3. HITL（Human-in-the-loop）硬性规则
如果使用 LangGraph 的 `interrupt()`：
1) **禁止**在 `interrupt()` 之前执行不可逆副作用（写盘、命令执行、git 写操作）。原因：resume 时节点会重跑。
2) `interrupt()` 的 payload 必须可 JSON 序列化（避免函数/复杂对象）。
3) **禁止**把 `interrupt()` 包进会吞掉异常的 try/catch。

## 4. 审批门（Approval Gates）必须覆盖的动作
以下动作一律视为“敏感动作”，必须经过 UI 审批门并写入审计日志：
- 写文件 / 删除文件 / 批量重命名
- 执行任何 shell 命令
- git 写操作：创建分支、stage、commit（以及任何未来扩展的写操作）

## 5. 术语一致性
- v0.1 使用 **Guardrails** 表述安全边界；不要在没有强隔离实现的前提下使用“Sandbox”误导。
- “100% 本地”必须同时参考 `docs/SECURITY_PRIVACY.md` 的 Data Egress Policy。
