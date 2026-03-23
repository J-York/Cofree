# Multi-Agent 质量重设计：对抗性验证架构

## 背景与动机

Cofree 当前的多 Agent 体系存在三个核心问题：

1. **同模型角色扮演**：所有 Agent 共用同一个 LLM，差异仅靠系统提示和工具白名单，"架构师"与"全栈工程师"本质是同一个大脑戴不同帽子。
2. **审查无对抗性**：reviewer 在 `sharedWorkingMemory: true` 下能看到 coder 的全部推理过程，认知偏差导致审查流于形式。
3. **验证靠 LLM 判断**：流水线缺少基于退出码的硬判断终态，tester 只是"设计测试策略"而非强制执行验证。

本设计通过**精简 Agent 数量、引入上下文隔离、量化质量门禁、强制工具验证**四项改动，让多 Agent 协作从"角色扮演"升级为"对抗性验证"，切实提升产出质量。

## 目标与优先级

- **P0 质量提升**：多 Agent 流水线的最终产出在代码质量、架构合理性、验证完整性上明显优于单 Agent
- **P1 效率提升**：通过并行阶段和精简流程减少总耗时

## 非目标

- 模型路由（不同角色用不同模型）：作为后续增强，本次不涉及
- 动态路由（`teamRouting.ts` 的 supervisor 模式）：继续预留，不落地

---

## 设计详述

### 1. 顶层 Agent 精简：5 → 2

**砍掉** `agent-code-reviewer`、`agent-architect`、`agent-qa`。

#### 1.1 通用 Agent（`agent-general`）

- 替代原 `agent-fullstack`
- 工具：全部（读 + 写 + shell + task）
- `handoffPolicy: "parallel"`
- `allowedSubAgents`: 全部（planner / coder / tester / debugger / reviewer / verifier）
- 系统提示：去角色扮演化，聚焦行为准则——深入理解需求、产出高质量代码、系统性排查问题、交付前自我验证
- 定位：默认选择，能独立完成所有任务，也可主动委派

#### 1.2 编排 Agent（`agent-orchestrator`）

- 替代原 `agent-concierge`
- 工具：只读 + fetch（无 `propose_*`）
- `handoffPolicy: "sequential"`
- `allowedSubAgents`: 全部
- 系统提示：聚焦需求对齐、选择合适的 Team/角色、向用户汇报进展和交付物；不独自实现
- 定位：不动手只编排

#### 1.3 被砍 Agent 的能力去向

| 被砍 Agent | 能力承接 |
|-----------|---------|
| 代码审查员 | 通用 Agent 自身 + reviewer 子 Agent（流水线深度审查） |
| 架构师 | 通用 Agent 自身 + planner 子 Agent（需求/架构分析） |
| QA 工程师 | tester 子 Agent + verifier 子 Agent（新增） |

#### 1.4 用户体验

Agent 选择器从 5 个变为 2 个。决策极简：要自己干选通用，要团队干选编排。

---

### 2. 子 Agent 重设计：上下文隔离与对抗性审查

#### 2.1 两类上下文模式

**共享上下文组（生产者）**：planner、coder、debugger
- 角色之间需传递完整上下文（planner 的计划被 coder 完整理解）
- 保持 working memory 共享

**隔离上下文组（验证者）**：reviewer、verifier
- 不接收生产者的推理过程
- 只接收事实材料（代码 diff、原始需求、文件内容、命令退出码）

#### 2.2 `contextPolicy` 机制

在 `AgentTeamStage` 类型上新增：

```typescript
interface AgentTeamStage {
  // ...existing fields...
  contextPolicy?: "shared" | "isolated";
  isolatedInputs?: IsolatedInputSpec;
}

interface IsolatedInputSpec {
  /** 是否注入原始用户需求 */
  fromOriginalRequest: boolean;
  /** 从哪个阶段取结构化输出 */
  fromStage?: string;
  /** 取哪些字段 */
  fields?: string[];
  /** 是否注入当前 git diff */
  includeGitDiff?: boolean;
  /** 注入指定文件的完整内容；"changed" 代表所有变更文件 */
  includeFileContents?: string[];
}
```

`teamExecutor` 行为：
- `contextPolicy: "shared"`（默认）：正常传递 working memory
- `contextPolicy: "isolated"`：**不传 working memory**，按 `isolatedInputs` 组装干净的、只包含事实材料的上下文

#### 2.3 reviewer 的隔离输入

reviewer 只接收：
- 原始用户需求（从流水线输入提取）
- git diff（coder 产出的实际代码变更）
- 被修改文件的完整内容（用于理解代码上下文）
- **不接收** coder 的推理过程、中间思考、"为什么这么写"

这迫使 reviewer 独立判断代码是否满足需求，独立发现问题，真正扮演"另一双眼睛"。

#### 2.4 新增子 Agent：verifier

```typescript
{
  role: "verifier",
  displayName: "Verifier",
  promptIntent: "Execute project test/lint/typecheck commands. Report pass/fail strictly based on exit codes. Never guess or assume results.",
  tools: ["propose_shell", "read_file", "glob"],
  sensitiveActionAllowed: false,
  allowAsSubAgent: true,
  subAgentMaxTurns: 10,
  outputSchemaHint: {
    commands: [{ cmd: "string", exitCode: "number", passed: "boolean" }],
    allPassed: "boolean",
    failureSummary: "string"
  }
}
```

verifier 与 tester 的区别：
- **tester**：设计测试策略、编写测试用例、分析覆盖度（偏策略）
- **verifier**：执行验证命令、报告硬结果（偏执行），是流水线终态的质量裁判

---

### 3. 结构化质量门禁

#### 3.1 reviewer 量化评分

新的 reviewer 输出 schema：

```typescript
interface ReviewOutput {
  dimensions: {
    correctness: { score: number; reasoning: string };   // 1-5
    security: { score: number; reasoning: string };      // 1-5
    maintainability: { score: number; reasoning: string }; // 1-5
    consistency: { score: number; reasoning: string };   // 1-5
  };
  issues: Array<{
    severity: "blocker" | "warning" | "suggestion";
    file: string;
    line?: number;
    message: string;
  }>;
  // verdict 不由 LLM 填写，由 teamExecutor 计算
}
```

#### 3.2 verdict 硬计算（`computeReviewVerdict`）

在 `teamExecutor` 中实现，逻辑如下：

```
verdict = "fail" 当以下任一条件成立：
  - 任意维度 score <= 2
  - 存在 severity === "blocker" 的 issue
  - correctness.score <= 3
否则 verdict = "pass"
```

关键：**LLM 只负责打分和列问题，通不通过由代码逻辑决定**。

#### 3.3 verifier 门禁（`computeVerifyVerdict`）

```
verdict = "pass" 当且仅当所有命令的 exitCode === 0
```

纯二值判断，无灰色地带。

#### 3.4 门禁触发的流水线行为

- `verdict === "pass"` → 继续下一阶段
- `verdict === "fail"` → 触发 coder 修复轮
  - 修复轮输入：reviewer 的 blocker + warning issues，或 verifier 的失败命令和 failureSummary
  - 修复后再次通过同类型验证者（reviewer 或 verifier），仍上下文隔离
  - 最多循环 `maxRepairRounds` 次（reviewer: 2, verifier: 1）
  - 超过上限仍 fail → `stop_reason: "quality_gate_failed"`，结果返回给用户/编排 Agent 决策

---

### 4. Team 流水线重设计：4 → 2

#### 4.1 `team-build`（构建流水线）

覆盖：新功能、重构、改进。

```
planner [shared]
  → coder [shared]
  → reviewer [isolated] ‖ tester [shared]    （并行）
  → if review_failed: coder修复 [shared] → reviewer复审 [isolated]（最多2轮）
  → verifier [isolated]
  → if verify_failed: coder修复 [shared] → verifier复验 [isolated]（最多1轮）
```

完整定义：

```typescript
{
  id: "team-build",
  name: "构建流水线",
  description: "需求分析 → 实现 → 审查(隔离)+测试(并行) → 门禁修复 → 最终验证",
  pipeline: [
    { agentRole: "planner", stageLabel: "需求分析", contextPolicy: "shared" },
    { agentRole: "coder", stageLabel: "实现", contextPolicy: "shared",
      inputMapping: { fromStage: "需求分析", fields: ["tasks", "riskAssessment"] } },
    { agentRole: "reviewer", stageLabel: "代码审查", contextPolicy: "isolated",
      isolatedInputs: { fromOriginalRequest: true, includeGitDiff: true, includeFileContents: ["changed"] },
      condition: { type: "if_previous_succeeded" },
      parallelGroup: "review_and_test" },
    { agentRole: "tester", stageLabel: "测试设计与执行", contextPolicy: "shared",
      condition: { type: "if_previous_succeeded" },
      parallelGroup: "review_and_test" },
    { agentRole: "coder", stageLabel: "审查问题修复", contextPolicy: "shared",
      condition: { type: "if_review_failed", refStageLabel: "代码审查" },
      inputMapping: { fromStage: "代码审查", fields: ["issues"] },
      maxRepairRounds: 2 },
    { agentRole: "verifier", stageLabel: "最终验证", contextPolicy: "isolated",
      isolatedInputs: { fromOriginalRequest: false },
      condition: { type: "if_previous_succeeded" } },
    { agentRole: "coder", stageLabel: "验证失败修复", contextPolicy: "shared",
      condition: { type: "if_verify_failed", refStageLabel: "最终验证" },
      inputMapping: { fromStage: "最终验证", fields: ["commands", "failureSummary"] },
      maxRepairRounds: 1 },
  ],
  config: { maxTotalTurns: 96, sharedWorkingMemory: true, failurePolicy: "stop", emitPlanCheckpoint: true },
}
```

#### 4.2 `team-fix`（修复流水线）

覆盖：bug 修复、调试。比 build 更轻量，跳过 planner 和 reviewer。

```
debugger [shared] → coder [shared] → verifier [isolated]
  → if verify_failed: coder修复 [shared] → verifier复验 [isolated]（最多1轮）
```

```typescript
{
  id: "team-fix",
  name: "修复流水线",
  description: "调试 → 修复 → 验证(硬门禁)",
  pipeline: [
    { agentRole: "debugger", stageLabel: "问题诊断", contextPolicy: "shared" },
    { agentRole: "coder", stageLabel: "修复实现", contextPolicy: "shared",
      inputMapping: { fromStage: "问题诊断", fields: ["rootCause", "fix"] } },
    { agentRole: "verifier", stageLabel: "修复验证", contextPolicy: "isolated",
      isolatedInputs: { fromOriginalRequest: false },
      condition: { type: "if_previous_succeeded" } },
    { agentRole: "coder", stageLabel: "验证失败修复", contextPolicy: "shared",
      condition: { type: "if_verify_failed", refStageLabel: "修复验证" },
      inputMapping: { fromStage: "修复验证", fields: ["commands", "failureSummary"] },
      maxRepairRounds: 1 },
  ],
  config: { maxTotalTurns: 60, sharedWorkingMemory: true, failurePolicy: "stop" },
}
```

#### 4.3 新增条件类型

```typescript
type AgentTeamStageConditionType =
  | "always"
  | "if_previous_succeeded"
  | "if_issues_found"
  | "if_issues_from_stage"
  | "if_stage_executed"
  | "if_review_failed"    // 新增：reviewer verdict === "fail"（由 computeReviewVerdict 计算）
  | "if_verify_failed";   // 新增：verifier allPassed === false
```

---

### 5. 变更影响范围

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/agents/builtinChatAgents.ts` | 重写 | 5 个 Agent → 2 个 |
| `src/agents/defaultAgents.ts` | 新增 | 添加 verifier 角色 |
| `src/agents/types.ts` | 修改 | `SubAgentRole` 增加 `"verifier"`；`AgentTeamStage` 增加 `contextPolicy`、`isolatedInputs`、`maxRepairRounds` |
| `src/agents/agentTeam.ts` | 重写 | 4 条流水线 → 2 条；新增条件类型；旧 Team ID 兼容映射 |
| `src/orchestrator/teamExecutor.ts` | 修改 | 支持 `contextPolicy: "isolated"` 的上下文组装；新增 `computeReviewVerdict`、`computeVerifyVerdict`；`maxRepairRounds` 循环逻辑 |
| `src/orchestrator/planningService.ts` | 小改 | `executeSubAgentTask` 适配 verifier 角色 |
| `src/agents/resolveAgentRuntime.ts` | 小改 | 适配新 Agent ID |
| `src/agents/promptAssembly.ts` | 修改 | 通用 Agent prompt 去角色扮演化 |
| `src/ui/components/TitleBar.tsx` | 小改 | Agent 选择器适配 |
| `src/ui/pages/chat/expertStageMessages.ts` | 修改 | 适配新流水线阶段标签 |
| `src/ui/pages/ChatPage.tsx` | 小改 | Team 相关 UI 文案更新 |

### 6. 向后兼容

- 已有对话绑定被砍 Agent ID → `getChatAgentFromSettings` fallback 到 `agent-general`
- 已有对话绑定被砍 Team ID → `agentTeam.ts` 新增兼容映射（`team-expert-panel` / `team-expert-panel-v2` → `team-build`；`team-full-cycle` → `team-build`；`team-debug-fix` → `team-fix`）
- 设置中的旧 `builtinAgentOverrides` 键 → 静默忽略

### 7. 不改的部分

- `planningService.ts` 主循环（`task` 工具机制、`runNativeToolCallingLoop`）
- `teamRouting.ts`（仍 `builtin_pipeline`，动态路由继续预留）
- 模型路由（全局单模型，后续增强）
- 用户自定义 Agent 机制（`customAgents` + `builtinAgentOverrides`）

### 8. 成功标准

| 指标 | 验证方式 |
|------|---------|
| reviewer 隔离有效性 | reviewer 的 issues 应包含 coder 未自行发现的问题（对比 coder 的 knownIssues vs reviewer 的 issues） |
| 门禁拦截率 | `verdict === "fail"` 的比例应 > 0（门禁在起作用，非橡皮图章） |
| verifier 终态准确性 | 流水线完成后，手动执行测试/lint 的结果应与 verifier 报告一致 |
| 修复轮收敛 | 大部分 fail 应在 1 轮修复后 pass，而非用尽 maxRepairRounds |
