# Cofree 多 Agent 协作架构演进计划

> 基于 v0.0.2 实际实现的代码分析 + 业界多 Agent 框架（AutoGen / CrewAI / LangGraph / MetaGPT / Cursor / Swarm）最佳实践，制定分阶段落地方案。
> 每个 Phase 独立可交付、可验收，后续 Phase 依赖前置 Phase 的产物。

---

## 总览：演进路线图

```
Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 4
共享工作记忆   结构化输出    反馈/重试     并行执行
  (P0)         (P0)         (P1)         (P1)
                              │
                              ▼
                          Phase 5 ──→ Phase 6 ──→ Phase 7
                         流式进度    特化 Agent   Agent Team
                          (P1)        (P2)        (P2)
```

| Phase | 名称 | 优先级 | 预估工作量 | 依赖 |
|-------|------|--------|-----------|------|
| 1 | 共享工作记忆（Working Memory） | P0 | 3-4 天 | 无 |
| 2 | Sub-Agent 结构化输出 | P0 | 2-3 天 | 无 |
| 3 | Sub-Agent 反馈与重试 | P1 | 2-3 天 | Phase 2 |
| 4 | 并行 Sub-Agent 执行 | P1 | 3-4 天 | Phase 1、2 |
| 5 | Sub-Agent 流式进度上报 | P1 | 2-3 天 | 无 |
| 6 | 特化 Agent 工作流 | P2 | 4-5 天 | Phase 1、2、3 |
| 7 | Agent Team 编排（handoffPolicy） | P2 | 5-7 天 | Phase 1、2、4 |

---

## Phase 1：共享工作记忆（Working Memory）

### 1.1 问题

当前 `executeSubAgentTask()` 中，Sub-Agent 启动时仅接收 `taskDescription` 文本：

```typescript
// planningService.ts L1791-1793（当前实现）
const messages: LiteLLMMessage[] = [
  { role: "system", content: subAgentSystemPrompt },
  { role: "user", content: taskDescription },  // ← 唯一的上下文
];
```

Sub-Agent 看不到主循环已读取的文件内容、已完成的分析结论、其他 Sub-Agent 的执行结果。这导致：
- 重复读取已知文件，浪费 token 和时间
- 无法利用前置 Sub-Agent 的工作成果
- 缺乏项目级上下文感知

### 1.2 方案设计

引入 `WorkingMemory` 数据结构，在主循环 session 生命周期内维护，作为所有 Agent/Sub-Agent 的共享知识层。

#### 新增类型定义

新文件 `src/orchestrator/workingMemory.ts`：

```typescript
export interface FileKnowledge {
  relativePath: string;
  summary: string;          // 文件摘要（由 LLM 或启发式生成）
  totalLines: number;
  language?: string;
  lastReadAt: string;       // ISO timestamp
  readByAgent: string;      // "main" | SubAgentRole
}

export interface DiscoveredFact {
  id: string;
  category: "architecture" | "dependency" | "api" | "config" | "convention" | "issue";
  content: string;
  source: string;           // 产生该 fact 的工具调用或 Agent
  confidence: "high" | "medium" | "low";
  createdAt: string;
}

export interface SubAgentExecRecord {
  role: SubAgentRole;
  taskDescription: string;
  replySummary: string;
  proposedActionCount: number;
  keyFindings: string[];    // 从结构化输出中提取（Phase 2 之后生效）
  completedAt: string;
}

export interface WorkingMemory {
  /** 已读取文件的知识摘要，key = relativePath */
  fileKnowledge: Map<string, FileKnowledge>;
  /** 发现的事实/结论 */
  discoveredFacts: DiscoveredFact[];
  /** Sub-Agent 执行历史 */
  subAgentHistory: SubAgentExecRecord[];
  /** 项目级上下文（从 .cofreerc + workspace overview 提取） */
  projectContext: string;
  /** Token 预算：Working Memory 序列化后不超过此值 */
  maxTokenBudget: number;
}
```

#### 核心函数

```typescript
/** 将 Working Memory 序列化为 LLM 可消费的上下文字符串 */
export function serializeWorkingMemory(
  memory: WorkingMemory,
  tokenBudget: number,
  forRole?: SubAgentRole,  // 可按角色裁剪
): string;

/** 从工具调用结果中提取文件知识 */
export function extractFileKnowledge(
  toolName: string,
  toolArgs: Record<string, unknown>,
  toolResult: string,
  agentId: string,
): FileKnowledge | null;

/** 添加发现事实（去重 + LRU 淘汰） */
export function addDiscoveredFact(
  memory: WorkingMemory,
  fact: Omit<DiscoveredFact, "id" | "createdAt">,
): void;

/** 从 Sub-Agent 结果中记录执行历史 */
export function recordSubAgentExecution(
  memory: WorkingMemory,
  record: Omit<SubAgentExecRecord, "completedAt">,
): void;
```

#### 集成到 `executeSubAgentTask()`

修改 `planningService.ts`：

```typescript
// 修改后的函数签名
async function executeSubAgentTask(
  role: string,
  taskDescription: string,
  workspacePath: string,
  settings: AppSettings,
  toolPermissions: ToolPermissions,
  workingMemory: WorkingMemory,    // ← 新增参数
): Promise<SubAgentResult> {
  // ...
  const memoryContext = serializeWorkingMemory(
    workingMemory,
    Math.floor(promptBudgetTarget * 0.15),  // 最多占 15% token 预算
    role as SubAgentRole,
  );

  const subAgentSystemPrompt = [
    `你是 Cofree 的 ${agentDef.displayName} Sub-Agent。`,
    `你的专长：${agentDef.promptIntent}`,
    `当前工作区: ${workspacePath}`,
    // ↓ 新增：注入共享知识
    memoryContext ? `\n## 已知上下文\n${memoryContext}` : "",
    "你正在执行一个被委派的子任务。请专注于完成任务并返回结果。",
    // ...
  ].filter(Boolean).join("\n");
  // ...
}
```

#### 主循环中维护 Working Memory

在 `runPlanningSession()` 中：

```typescript
// 在主循环初始化时创建
const workingMemory: WorkingMemory = createWorkingMemory({
  maxTokenBudget: Math.floor(promptBudgetTarget * 0.2),
  projectContext: workspaceOverview ?? "",
});

// 每次工具调用成功后更新
for (const toolCall of completion.toolCalls) {
  const { result, trace } = await executeToolCallWithRetry(...);
  // ↓ 新增
  const knowledge = extractFileKnowledge(
    toolCall.function.name,
    parsedArgs,
    result.content,
    "main",
  );
  if (knowledge) {
    workingMemory.fileKnowledge.set(knowledge.relativePath, knowledge);
  }
}

// 传递给 Sub-Agent
const subResult = await executeSubAgentTask(
  role, description, safeWorkspace, settings, toolPermissions,
  workingMemory,  // ← 传递
);

// Sub-Agent 完成后更新 Working Memory
recordSubAgentExecution(workingMemory, {
  role: role as SubAgentRole,
  taskDescription: description,
  replySummary: subResult.reply.slice(0, 500),
  proposedActionCount: subResult.proposedActions.length,
  keyFindings: [],  // Phase 2 后从结构化输出中提取
});
```

### 1.3 序列化策略

`serializeWorkingMemory` 按以下优先级构建上下文字符串（在 token 预算内）：

1. **项目上下文**（最高优先）：项目类型、技术栈、入口文件等
2. **高置信度事实**：已确认的架构决策、关键约束
3. **相关文件摘要**：按与当前任务的相关性排序（如 coder 角色优先看已读取文件）
4. **Sub-Agent 历史**：之前的 Sub-Agent 做了什么、发现了什么
5. **中低置信度事实**（最低优先）

超出预算时从底部截断。

### 1.4 Token 预算控制

- Working Memory 在主循环中最多占 **20%** prompt token 预算
- 注入 Sub-Agent 时最多占 **15%**（Sub-Agent 上下文窗口更小）
- 文件摘要单条不超过 200 字符
- 事实总数上限 50 条，超出后 LRU 淘汰 confidence=low 的条目
- 超过预算时优先丢弃 `toolTrace` 和低 confidence 事实

### 1.5 实现步骤

| 步骤 | 描述 | 涉及文件 |
|------|------|---------|
| 1.5.1 | 创建 `workingMemory.ts` 定义类型和核心函数 | 新文件 `src/orchestrator/workingMemory.ts` |
| 1.5.2 | 实现 `serializeWorkingMemory` 含 token 预算裁剪 | `workingMemory.ts` |
| 1.5.3 | 实现 `extractFileKnowledge` 从 read_file/grep/glob 结果提取 | `workingMemory.ts` |
| 1.5.4 | 在 `runPlanningSession()` 中创建和维护 WorkingMemory | `planningService.ts` |
| 1.5.5 | 修改 `executeSubAgentTask()` 接收和注入 WorkingMemory | `planningService.ts` |
| 1.5.6 | 将 WorkingMemory 纳入 checkpoint 持久化 | `checkpointStore.ts` |
| 1.5.7 | 单元测试 | 新文件 `tests/workingMemory.test.ts` |

### 1.6 验收标准

- 对同一项目连续委派 planner → coder 时，coder 不再重复读取 planner 已读过的文件
- Working Memory 序列化后 token 数不超过配置预算
- session 恢复后 Working Memory 从 checkpoint 正确恢复

---

## Phase 2：Sub-Agent 结构化输出

### 2.1 问题

当前 `SubAgentResult.reply` 是自由文本，主 Agent 只能通过自然语言理解 Sub-Agent 的工作结果：

```typescript
// planningService.ts L1751-1756（当前实现）
interface SubAgentResult {
  reply: string;              // ← 自由文本，无法机器解析
  proposedActions: ActionProposal[];
  toolTrace: ToolExecutionTrace[];
  turnCount: number;
}
```

### 2.2 方案设计

为每种 Sub-Agent 角色定义结构化输出 schema，同时保留 `reply` 作为兜底。

#### 新增类型定义

修改 `src/agents/types.ts`：

```typescript
// --- 结构化输出 ---

export interface PlannerOutput {
  tasks: Array<{
    title: string;
    description: string;
    targetFiles: string[];
    estimatedComplexity: "low" | "medium" | "high";
    dependencies?: string[];  // 其他 task 的 title
  }>;
  riskAssessment?: string;
  architectureNotes?: string;
}

export interface CoderOutput {
  changedFiles: string[];
  summary: string;
  implementationNotes?: string;
  knownIssues?: string[];
}

export interface TesterOutput {
  testPlan: Array<{
    testCase: string;
    steps: string[];
    expectedResult: string;
    actualResult?: string;
    passed?: boolean;
  }>;
  riskLevel: "low" | "medium" | "high";
  coverageGaps?: string[];
}

export type StructuredSubAgentOutput =
  | { role: "planner"; data: PlannerOutput }
  | { role: "coder"; data: CoderOutput }
  | { role: "tester"; data: TesterOutput };
```

#### 修改 SubAgentResult

```typescript
interface SubAgentResult {
  reply: string;
  proposedActions: ActionProposal[];
  toolTrace: ToolExecutionTrace[];
  turnCount: number;
  structuredOutput?: StructuredSubAgentOutput;  // ← 新增
}
```

#### 提取策略

在 `executeSubAgentTask()` 返回前，尝试从 Sub-Agent 的最终 reply 中提取结构化输出：

```typescript
// 方案 A：在 Sub-Agent system prompt 中要求 JSON 输出（简单但可能影响回复质量）
// 方案 B：Sub-Agent 回复后，追加一轮 extraction call（可靠但多一次 API 调用）
// 方案 C：启发式解析 reply 文本（低成本但不稳定）

// ★ 推荐方案 B 的轻量变体：
// 在 Sub-Agent system prompt 中追加 JSON schema 指引，
// 如果 reply 中包含 ```json 块则解析，否则 structuredOutput = undefined
```

具体实现：

```typescript
function tryExtractStructuredOutput(
  role: SubAgentRole,
  reply: string,
): StructuredSubAgentOutput | undefined {
  // 尝试从 reply 中提取 ```json ... ``` 块
  const jsonMatch = reply.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch) return undefined;

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    // 根据 role 做 schema 验证
    return validateAndNormalize(role, parsed);
  } catch {
    return undefined;
  }
}
```

#### 修改 Sub-Agent System Prompt

在 `defaultAgents.ts` 中为每个角色增加输出格式指引：

```typescript
{
  role: "planner",
  displayName: "Planner",
  promptIntent: "Break user requests into verifiable development steps.",
  // ↓ 新增
  outputSchemaHint: `完成分析后，请在回复末尾附上结构化输出：
\`\`\`json
{
  "tasks": [{"title": "...", "description": "...", "targetFiles": [...], "estimatedComplexity": "low|medium|high"}],
  "riskAssessment": "...",
  "architectureNotes": "..."
}
\`\`\``,
  // ...
}
```

#### 主 Agent 消费结构化输出

修改 `task` 工具返回内容（在 `executeToolCallWithRetry` 的 task 分支中）：

```typescript
const responsePayload: Record<string, unknown> = {
  ok: true,
  action_type: "sub_agent_task",
  role,
  turn_count: subResult.turnCount,
  reply: subResult.reply,
  proposed_action_count: subResult.proposedActions.length,
  // ↓ 新增：如果有结构化输出则附加
  structured_output: subResult.structuredOutput?.data ?? null,
};
```

### 2.3 与 Phase 1 的联动

结构化输出中的 `keyFindings` 可以自动注入 Working Memory：

```typescript
if (subResult.structuredOutput?.role === "planner") {
  const plannerData = subResult.structuredOutput.data;
  // 将架构分析结论作为 discovered fact 记录
  if (plannerData.architectureNotes) {
    addDiscoveredFact(workingMemory, {
      category: "architecture",
      content: plannerData.architectureNotes,
      source: `planner:${description.slice(0, 100)}`,
      confidence: "high",
    });
  }
  // 将任务列表摘要记录为执行历史的 keyFindings
  record.keyFindings = plannerData.tasks.map(t => t.title);
}
```

### 2.4 实现步骤

| 步骤 | 描述 | 涉及文件 |
|------|------|---------|
| 2.4.1 | 在 `types.ts` 中新增 PlannerOutput/CoderOutput/TesterOutput 类型 | `src/agents/types.ts` |
| 2.4.2 | 实现 `tryExtractStructuredOutput` 解析函数 | 新文件 `src/agents/structuredOutput.ts` |
| 2.4.3 | 修改 SubAgentDefinition 增加 `outputSchemaHint` | `src/agents/defaultAgents.ts` |
| 2.4.4 | 修改 `executeSubAgentTask()` 在返回前尝试提取结构化输出 | `planningService.ts` |
| 2.4.5 | 修改 task 工具返回 payload 附加 `structured_output` | `planningService.ts` |
| 2.4.6 | 与 Working Memory 联动（如果 Phase 1 已完成） | `planningService.ts` |
| 2.4.7 | 单元测试 | 新文件 `tests/structuredOutput.test.ts` |

### 2.5 验收标准

- planner Sub-Agent 的输出中包含 JSON 结构化任务列表，可被主 Agent 精确引用
- 结构化输出提取失败时不影响正常流程（graceful degradation）
- 厨房页的工具追踪时间线中展示结构化输出的摘要

---

## Phase 3：Sub-Agent 反馈与重试

### 3.1 问题

当前 Sub-Agent 无法向主 Agent 表达：
- "任务描述不够清晰，我需要更多信息"
- "我遇到了阻塞，需要先执行另一个前置步骤"
- "方案有冲突，需要人工决策"

Sub-Agent 只能尽力完成或静默失败。

### 3.2 方案设计

#### 扩展 SubAgentResult 状态

```typescript
export type SubAgentCompletionStatus =
  | "completed"           // 正常完成
  | "partial"             // 部分完成，有剩余工作
  | "need_clarification"  // 需要更多信息
  | "blocked"             // 被阻塞
  | "failed";             // 执行失败

interface SubAgentResult {
  reply: string;
  status: SubAgentCompletionStatus;    // ← 新增
  proposedActions: ActionProposal[];
  toolTrace: ToolExecutionTrace[];
  turnCount: number;
  structuredOutput?: StructuredSubAgentOutput;
  // ↓ 新增：反馈信息
  feedback?: {
    reason: string;
    missingContext?: string[];   // 需要的额外信息
    suggestedAction?: string;   // 建议主 Agent 做什么
    blockedBy?: string;         // 阻塞原因
  };
}
```

#### 主循环的重试逻辑

在 `task` 工具的处理分支中加入重试机制：

```typescript
if (call.function.name === "task") {
  // ... 验证逻辑 ...
  const MAX_SUB_AGENT_RETRIES = 2;
  let lastResult: SubAgentResult | null = null;

  for (let attempt = 0; attempt <= MAX_SUB_AGENT_RETRIES; attempt++) {
    const enrichedDescription = attempt === 0
      ? description
      : buildRetryDescription(description, lastResult!);

    const subResult = await executeSubAgentTask(
      role, enrichedDescription, safeWorkspace, settings, toolPermissions, workingMemory,
    );
    lastResult = subResult;

    // 如果 Sub-Agent 正常完成或已用完重试次数，返回结果
    if (subResult.status === "completed" || attempt >= MAX_SUB_AGENT_RETRIES) {
      break;
    }

    // 如果需要澄清，将反馈注入重试的 description
    if (subResult.status === "need_clarification" && subResult.feedback) {
      console.log(`[SubAgent] 需要澄清 (attempt ${attempt + 1}): ${subResult.feedback.reason}`);
      continue;
    }

    // 如果被阻塞，直接返回让主 Agent 处理
    if (subResult.status === "blocked") {
      break;
    }
  }

  // 构建返回 payload，包含状态和反馈信息
  const responsePayload = {
    ok: lastResult!.status === "completed",
    status: lastResult!.status,
    // ...
    feedback: lastResult!.feedback ?? null,
  };
}
```

#### `buildRetryDescription` 函数

```typescript
function buildRetryDescription(
  originalDescription: string,
  previousResult: SubAgentResult,
): string {
  const parts = [originalDescription];

  if (previousResult.feedback) {
    parts.push(
      "\n## 上一次尝试的反馈",
      `状态: ${previousResult.status}`,
      `原因: ${previousResult.feedback.reason}`,
    );
    if (previousResult.feedback.missingContext?.length) {
      parts.push(`缺少的上下文: ${previousResult.feedback.missingContext.join(", ")}`);
    }
    if (previousResult.feedback.suggestedAction) {
      parts.push(`建议: ${previousResult.feedback.suggestedAction}`);
    }
  }

  // 附上 Working Memory 中与反馈相关的补充信息
  // （例如 Sub-Agent 说"需要了解 X 文件"，从 Working Memory 中查找 X 的摘要）
  return parts.join("\n");
}
```

#### Sub-Agent 如何产生反馈

在 Sub-Agent 的 system prompt 中增加指引：

```
如果你发现任务描述不够清晰或缺少必要信息，请在回复中说明：
- 你需要什么额外信息
- 你建议主任务做什么来解除阻塞
请使用以下 JSON 格式标记：
```json
{"status": "need_clarification", "reason": "...", "missingContext": [...]}
```
```

同时在 `tryExtractStructuredOutput` 的同一个 JSON 块中，兼容解析 status 字段。

### 3.3 实现步骤

| 步骤 | 描述 | 涉及文件 |
|------|------|---------|
| 3.3.1 | 扩展 SubAgentResult 增加 status 和 feedback 字段 | `planningService.ts` |
| 3.3.2 | 修改 Sub-Agent system prompt 增加反馈格式指引 | `defaultAgents.ts` |
| 3.3.3 | 实现 `tryExtractFeedback` 从 reply 中提取状态和反馈 | `structuredOutput.ts` |
| 3.3.4 | 在 task 工具分支实现重试循环 + `buildRetryDescription` | `planningService.ts` |
| 3.3.5 | 修改返回 payload 包含 status/feedback | `planningService.ts` |
| 3.3.6 | 单元测试 | `tests/subAgentFeedback.test.ts` |

### 3.4 验收标准

- 当 Sub-Agent 回复 `need_clarification` 时，主循环自动用补充信息重试
- 重试次数不超过 2 次，避免无限循环
- `blocked` 状态的反馈能正确传递给主 Agent，主 Agent 可以据此调整策略

---

## Phase 4：并行 Sub-Agent 执行

### 4.1 问题

当前所有 `task` 调用都是串行 `await`。当主 Agent 在一轮工具调用中同时发起多个 `task` 时（例如 `task(planner, "分析模块A")` 和 `task(planner, "分析模块B")`），它们被顺序执行。

### 4.2 方案设计

#### 核心思路

LLM 原生支持在一轮 response 中返回多个 tool_calls。当检测到同一轮中有多个 `task` 调用时，用 `Promise.allSettled` 并行执行。

#### 修改 `planningService.ts` 主循环中的工具执行逻辑

当前工具执行是逐个串行的（for...of 循环）。改为分组执行：

```typescript
// 将同一轮的 tool calls 分为两组
const taskCalls = completion.toolCalls.filter(tc => tc.function.name === "task");
const otherCalls = completion.toolCalls.filter(tc => tc.function.name !== "task");

// 非 task 工具仍然串行执行（因为可能有依赖关系，如 read_file → propose_file_edit）
for (const toolCall of otherCalls) {
  const { result, trace } = await executeToolCallWithRetry(...);
  // ...处理结果...
}

// task 工具并行执行
if (taskCalls.length > 1) {
  console.log(`[Orchestrator] 并行执行 ${taskCalls.length} 个 Sub-Agent 任务`);
  const taskPromises = taskCalls.map(tc => executeToolCallWithRetry(tc, ...));
  const taskResults = await Promise.allSettled(taskPromises);
  // ...处理所有结果...
} else if (taskCalls.length === 1) {
  // 单个 task 调用走原有逻辑
  const { result, trace } = await executeToolCallWithRetry(taskCalls[0], ...);
  // ...处理结果...
}
```

#### Working Memory 并发安全

并行 Sub-Agent 同时读取 Working Memory 不需要锁（只读）。但并行 Sub-Agent 各自产生的新知识需要在全部完成后合并：

```typescript
const parallelResults = await Promise.allSettled(taskPromises);

// 合并所有 Sub-Agent 的新发现到 Working Memory
for (const result of parallelResults) {
  if (result.status === "fulfilled") {
    const subResult = result.value;
    mergeSubAgentKnowledge(workingMemory, subResult);
  }
}
```

#### 并行限制

- 最大并行 Sub-Agent 数量：**3**（避免过多并发 API 调用导致限流）
- 如果超过 3 个 task 调用，前 3 个并行，后续排队
- 每个并行 Sub-Agent 的 token 预算需要考虑并发因素（总预算 / 并行数 * 安全系数）

#### task 工具 description 更新

修改 `task` 工具的 description，告知 LLM 可以并行：

```typescript
description:
  "Delegate a sub-task to a specialized sub-agent. " +
  "Multiple task calls in the same turn will be executed in parallel. " +
  "Use this for independent tasks that don't depend on each other's results.",
```

### 4.3 实现步骤

| 步骤 | 描述 | 涉及文件 |
|------|------|---------|
| 4.3.1 | 重构主循环工具执行逻辑，分离 task 和非 task 调用 | `planningService.ts` |
| 4.3.2 | 实现 `Promise.allSettled` 并行执行逻辑 | `planningService.ts` |
| 4.3.3 | 实现并行结果合并和错误处理 | `planningService.ts` |
| 4.3.4 | Working Memory 并发合并逻辑 | `workingMemory.ts` |
| 4.3.5 | 更新 `task` 工具 description | `planningService.ts` |
| 4.3.6 | 并行限流（Semaphore） | 新文件 `src/lib/concurrency.ts` |
| 4.3.7 | 集成测试 | `tests/parallelSubAgent.test.ts` |

### 4.4 验收标准

- 主 Agent 在一轮中发起 2+ 个 task 调用时并行执行
- 并行执行耗时接近单个最长 Sub-Agent 的耗时（而非所有之和）
- 一个 Sub-Agent 失败不影响其他并行 Sub-Agent 的执行
- Working Memory 正确合并所有并行 Sub-Agent 的产出

---

## Phase 5：Sub-Agent 流式进度上报

### 5.1 问题

Sub-Agent 执行过程中用户看不到任何中间状态。复杂的 Sub-Agent 可能运行十几轮工具调用，用户只能等待。

### 5.2 方案设计

#### 进度回调机制

修改 `executeSubAgentTask` 签名增加 progress callback：

```typescript
export type SubAgentProgressEvent =
  | { kind: "tool_start"; toolName: string; turn: number; maxTurns: number }
  | { kind: "tool_complete"; toolName: string; success: boolean; durationMs: number }
  | { kind: "thinking"; partialContent: string }
  | { kind: "action_proposed"; actionType: SensitiveActionType; description: string }
  | { kind: "summary"; message: string };

async function executeSubAgentTask(
  role: string,
  taskDescription: string,
  workspacePath: string,
  settings: AppSettings,
  toolPermissions: ToolPermissions,
  workingMemory: WorkingMemory,
  onProgress?: (event: SubAgentProgressEvent) => void,  // ← 新增
): Promise<SubAgentResult> {
  // 在每个关键点调用 onProgress
  for (let turn = 0; turn < maxTurns; turn += 1) {
    // ...
    for (const toolCall of completion.toolCalls) {
      onProgress?.({ kind: "tool_start", toolName: toolCall.function.name, turn, maxTurns });
      const { result, trace } = await executeToolCallWithRetry(...);
      onProgress?.({
        kind: "tool_complete",
        toolName: toolCall.function.name,
        success: result.success !== false,
        durationMs: trace.durationMs,
      });
    }
  }
}
```

#### UI 集成

在 `ChatPage.tsx` 中通过 `onProgress` 回调更新 session context：

```typescript
const onSubAgentProgress = (event: SubAgentProgressEvent) => {
  // 更新 sessionContext 的 toolTraces（实时）
  if (event.kind === "tool_complete") {
    addToolTrace({ ... });
  }
  // 更新厨房页的 Sub-Agent 状态面板
  updateSubAgentStatus(role, event);
};
```

#### 用户中断能力

利用 `AbortController` 支持 Sub-Agent 中途取消：

```typescript
async function executeSubAgentTask(
  // ...
  signal?: AbortSignal,  // ← 新增
): Promise<SubAgentResult> {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (signal?.aborted) {
      return {
        reply: "Sub-Agent 已被用户中断。",
        status: "partial",
        proposedActions,
        toolTrace,
        turnCount: turn,
      };
    }
    // ...
  }
}
```

### 5.3 实现步骤

| 步骤 | 描述 | 涉及文件 |
|------|------|---------|
| 5.3.1 | 定义 `SubAgentProgressEvent` 类型 | `src/orchestrator/types.ts` |
| 5.3.2 | 修改 `executeSubAgentTask` 增加 `onProgress` 和 `signal` | `planningService.ts` |
| 5.3.3 | 在每个关键点发出进度事件 | `planningService.ts` |
| 5.3.4 | ChatPage 中接收进度事件并更新 UI | `ChatPage.tsx` |
| 5.3.5 | 厨房页增加 Sub-Agent 实时状态面板 | `KitchenPage.tsx` |
| 5.3.6 | 实现用户中断按钮 | `ChatPage.tsx` |

### 5.4 验收标准

- Sub-Agent 执行期间，用户在聊天区看到实时进度提示（如 "Coder 正在读取文件 X..."）
- 厨房页展示 Sub-Agent 的轮次进度和工具调用明细
- 用户可以点击"取消"按钮中断正在运行的 Sub-Agent

---

## Phase 6：特化 Agent 工作流

### 6.1 问题

当前三个 Sub-Agent 仅在 tools 和 promptIntent 上有差异，没有专属的推理策略和工作流程。

### 6.2 方案设计

#### 新增特化角色

扩展 `SubAgentRole`：

```typescript
export type SubAgentRole =
  | "planner"
  | "coder"
  | "tester"
  | "debugger"     // ← 新增：假设驱动调试
  | "reviewer";    // ← 新增：结构化代码审查
```

#### Debugger Agent 设计

参考 Cursor 的 debug subagent，采用**假设驱动调试**工作流：

```typescript
{
  role: "debugger",
  displayName: "Debugger",
  promptIntent: "Investigate bugs using hypothesis-driven debugging with instrumentation.",
  tools: ["read_file", "grep", "glob", "git_diff", "diagnostics", "propose_file_edit", "propose_shell"],
  sensitiveActionAllowed: false,
  allowAsSubAgent: true,
  subAgentMaxTurns: 30,
  // ↓ 特化工作流指引
  workflowTemplate: `
## 调试工作流
1. **理解问题**：读取相关代码和错误信息
2. **形成假设**：基于证据提出 1-3 个可能的根因假设
3. **验证假设**：通过阅读代码、搜索模式、运行诊断来验证/排除假设
4. **定位根因**：确认最可能的根因
5. **提出修复**：使用 propose_file_edit 提出修复方案

输出格式：
\`\`\`json
{
  "hypotheses": [{"description": "...", "evidence": "...", "status": "confirmed|rejected|pending"}],
  "rootCause": "...",
  "fix": "..."
}
\`\`\`
  `,
}
```

#### Reviewer Agent 设计

```typescript
{
  role: "reviewer",
  displayName: "Reviewer",
  promptIntent: "Perform structured code review with quality assessment.",
  tools: ["read_file", "grep", "glob", "git_diff", "diagnostics"],
  sensitiveActionAllowed: false,
  allowAsSubAgent: true,
  subAgentMaxTurns: 20,
  workflowTemplate: `
## 审查工作流
1. **变更范围**：通过 git_diff 了解本次变更
2. **逐文件审查**：读取每个变更文件，检查代码质量
3. **交叉影响**：grep 搜索受影响的调用方
4. **输出报告**：按严重程度分类的审查意见

审查维度：正确性 | 安全性 | 性能 | 可维护性 | 一致性

输出格式：
\`\`\`json
{
  "issues": [{"severity": "critical|warning|suggestion", "file": "...", "line": N, "message": "..."}],
  "overallAssessment": "approve|request_changes|comment",
  "summary": "..."
}
\`\`\`
  `,
}
```

#### SubAgentDefinition 扩展

```typescript
export interface SubAgentDefinition {
  role: SubAgentRole;
  displayName: string;
  promptIntent: string;
  tools: string[];
  sensitiveActionAllowed: boolean;
  allowAsSubAgent?: boolean;
  subAgentMaxTurns?: number;
  // ↓ Phase 2 新增
  outputSchemaHint?: string;
  // ↓ Phase 6 新增
  workflowTemplate?: string;      // 特化工作流模板
  requiredContextKeys?: string[];  // 依赖的 Working Memory 类别
}
```

#### 集成到 Sub-Agent System Prompt

```typescript
const subAgentSystemPrompt = [
  `你是 Cofree 的 ${agentDef.displayName} Sub-Agent。`,
  `你的专长：${agentDef.promptIntent}`,
  `当前工作区: ${workspacePath}`,
  // ↓ 注入特化工作流
  agentDef.workflowTemplate ? `\n${agentDef.workflowTemplate}` : "",
  // ↓ 注入输出格式指引
  agentDef.outputSchemaHint ? `\n${agentDef.outputSchemaHint}` : "",
  // ↓ 注入共享记忆
  memoryContext ? `\n## 已知上下文\n${memoryContext}` : "",
  "你正在执行一个被委派的子任务。请专注于完成任务并返回结果。",
].filter(Boolean).join("\n");
```

### 6.3 实现步骤

| 步骤 | 描述 | 涉及文件 |
|------|------|---------|
| 6.3.1 | 扩展 SubAgentRole 增加 debugger/reviewer | `types.ts` |
| 6.3.2 | 在 defaultAgents.ts 中定义新角色 | `defaultAgents.ts` |
| 6.3.3 | 扩展 SubAgentDefinition 增加 workflowTemplate | `types.ts`, `defaultAgents.ts` |
| 6.3.4 | 修改 Sub-Agent system prompt 组装逻辑 | `planningService.ts` |
| 6.3.5 | 为新角色定义结构化输出 schema | `structuredOutput.ts` |
| 6.3.6 | 更新 ChatAgent 的 allowedSubAgents | `builtinChatAgents.ts` |
| 6.3.7 | 更新 SettingsPage Sub-Agent 切换 UI | `SettingsPage.tsx` |
| 6.3.8 | 测试新角色的工作流 | `tests/specializedAgents.test.ts` |

### 6.4 验收标准

- debugger Sub-Agent 能产出结构化的假设-验证-修复报告
- reviewer Sub-Agent 能产出按严重程度分类的审查报告
- 新角色可在设置页中开关

---

## Phase 7：Agent Team 编排（handoffPolicy）

### 7.1 问题

当前已预留的 `handoffPolicy` 和 `teamMembers` 字段未实现。无法定义 "架构师分析 → 全栈工程师实现 → QA 验证" 这样的完整工作流。

### 7.2 方案设计

#### Agent Team 定义

新文件 `src/agents/agentTeam.ts`：

```typescript
export interface AgentTeamDefinition {
  id: string;
  name: string;
  description: string;
  /** 按执行顺序排列的 Agent（sequential 模式） */
  pipeline: AgentTeamStage[];
  /** 团队级配置 */
  config: {
    maxTotalTurns: number;
    sharedWorkingMemory: boolean;
    failurePolicy: "stop" | "skip" | "retry";
  };
}

export interface AgentTeamStage {
  agentRole: SubAgentRole;
  stageLabel: string;
  /** 可选：前一阶段的哪些输出作为本阶段的输入 */
  inputMapping?: {
    fromStage: string;
    fields: string[];
  };
  /** 可选：执行条件 */
  condition?: {
    type: "always" | "if_previous_succeeded" | "if_issues_found";
  };
}
```

#### 预设 Team

```typescript
export const BUILTIN_TEAMS: AgentTeamDefinition[] = [
  {
    id: "team-full-cycle",
    name: "完整开发周期",
    description: "分析 → 实现 → 审查 → 测试",
    pipeline: [
      { agentRole: "planner", stageLabel: "需求分析与任务拆解" },
      { agentRole: "coder", stageLabel: "代码实现", inputMapping: { fromStage: "planner", fields: ["tasks"] } },
      { agentRole: "reviewer", stageLabel: "代码审查", condition: { type: "if_previous_succeeded" } },
      { agentRole: "tester", stageLabel: "测试验证", condition: { type: "if_previous_succeeded" } },
    ],
    config: { maxTotalTurns: 80, sharedWorkingMemory: true, failurePolicy: "stop" },
  },
  {
    id: "team-debug-fix",
    name: "调试修复",
    description: "调试 → 修复 → 验证",
    pipeline: [
      { agentRole: "debugger", stageLabel: "问题诊断" },
      { agentRole: "coder", stageLabel: "修复实现", inputMapping: { fromStage: "debugger", fields: ["rootCause", "fix"] } },
      { agentRole: "tester", stageLabel: "修复验证", condition: { type: "if_previous_succeeded" } },
    ],
    config: { maxTotalTurns: 60, sharedWorkingMemory: true, failurePolicy: "retry" },
  },
];
```

#### Team 执行引擎

新文件 `src/orchestrator/teamExecutor.ts`：

```typescript
export async function executeAgentTeam(params: {
  team: AgentTeamDefinition;
  taskDescription: string;
  workspacePath: string;
  settings: AppSettings;
  toolPermissions: ToolPermissions;
  workingMemory: WorkingMemory;
  onStageProgress?: (stage: string, event: SubAgentProgressEvent) => void;
  signal?: AbortSignal;
}): Promise<TeamExecutionResult> {
  const { team, taskDescription, workspacePath, settings, toolPermissions, workingMemory } = params;
  const stageResults: Map<string, SubAgentResult> = new Map();

  for (const stage of team.pipeline) {
    // 检查执行条件
    if (!shouldExecuteStage(stage, stageResults)) {
      continue;
    }

    // 构建本阶段的任务描述，注入前置阶段的输出
    const stageDescription = buildStageDescription(
      taskDescription,
      stage,
      stageResults,
    );

    // 执行 Sub-Agent
    const result = await executeSubAgentTask(
      stage.agentRole,
      stageDescription,
      workspacePath,
      settings,
      toolPermissions,
      workingMemory,
      (event) => params.onStageProgress?.(stage.stageLabel, event),
      params.signal,
    );

    stageResults.set(stage.stageLabel, result);

    // 根据 failurePolicy 决定是否继续
    if (result.status === "failed" && team.config.failurePolicy === "stop") {
      break;
    }
  }

  return aggregateTeamResults(team, stageResults);
}
```

#### 集成到 `task` 工具

扩展 `task` 工具支持 team 模式：

```typescript
{
  name: "task",
  parameters: {
    properties: {
      role: { type: "string", enum: ["planner", "coder", "tester", "debugger", "reviewer"] },
      description: { type: "string" },
      // ↓ 新增：可选的 team 模式
      team: {
        type: "string",
        enum: ["full-cycle", "debug-fix"],
        description: "Optional: run a predefined agent team pipeline instead of a single sub-agent.",
      },
    },
  },
}
```

当 `team` 参数存在时，调用 `executeAgentTeam` 而非 `executeSubAgentTask`。

### 7.3 handoffPolicy 的 parallel 模式

对于 `parallel` 模式，结合 Phase 4 的并行能力，支持 pipeline 中标记为可并行的阶段同时执行：

```typescript
export interface AgentTeamStage {
  // ... 已有字段 ...
  /** 可与哪些阶段并行执行 */
  parallelGroup?: string;
}

// 执行引擎中，将相同 parallelGroup 的阶段用 Promise.allSettled 并行
```

### 7.4 实现步骤

| 步骤 | 描述 | 涉及文件 |
|------|------|---------|
| 7.4.1 | 定义 AgentTeamDefinition 类型 | 新文件 `src/agents/agentTeam.ts` |
| 7.4.2 | 定义预设 Team 配置 | `agentTeam.ts` |
| 7.4.3 | 实现 `executeAgentTeam` 流水线执行引擎 | 新文件 `src/orchestrator/teamExecutor.ts` |
| 7.4.4 | 实现阶段间数据传递 (`buildStageDescription`) | `teamExecutor.ts` |
| 7.4.5 | 扩展 `task` 工具支持 `team` 参数 | `planningService.ts` |
| 7.4.6 | 厨房页增加 Team 执行状态面板 | `KitchenPage.tsx` |
| 7.4.7 | 设置页增加 Team 选择和配置 UI | `SettingsPage.tsx` |
| 7.4.8 | 集成测试 | `tests/agentTeam.test.ts` |

### 7.5 验收标准

- 全栈工程师 Agent 可以委派 "full-cycle" team 执行一个完整的开发周期
- 每个阶段的输出正确传递给下一阶段
- 中间阶段失败时按 failurePolicy 正确处理
- 厨房页展示 Team 执行的每个阶段状态

---

## 附录 A：跨 Phase 改动汇总（按文件）

| 文件 | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 | Phase 6 | Phase 7 |
|------|---------|---------|---------|---------|---------|---------|---------|
| `src/agents/types.ts` | — | ✦ 新增结构化输出类型 | ✦ 扩展 SubAgentResult | — | — | ✦ 扩展 SubAgentRole | — |
| `src/agents/defaultAgents.ts` | — | ✦ 增加 outputSchemaHint | ✦ 增加反馈格式指引 | — | — | ✦ 新增 debugger/reviewer | — |
| `src/agents/builtinChatAgents.ts` | — | — | — | — | — | ✦ 更新 allowedSubAgents | — |
| `src/orchestrator/planningService.ts` | ✦ 集成 WorkingMemory | ✦ 提取结构化输出 | ✦ 重试循环 | ✦ 并行执行 | ✦ onProgress 回调 | ✦ 特化 prompt | ✦ team 参数 |
| `src/orchestrator/types.ts` | — | — | — | — | ✦ SubAgentProgressEvent | — | — |
| `src/orchestrator/checkpointStore.ts` | ✦ 持久化 WorkingMemory | — | — | — | — | — | — |
| `src/ui/pages/ChatPage.tsx` | — | — | — | — | ✦ 进度 UI | — | — |
| `src/ui/pages/KitchenPage.tsx` | — | — | — | — | ✦ Sub-Agent 面板 | — | ✦ Team 面板 |
| `src/ui/pages/SettingsPage.tsx` | — | — | — | — | — | ✦ 新角色开关 | ✦ Team 配置 |

**新增文件汇总：**

| 文件 | Phase | 描述 |
|------|-------|------|
| `src/orchestrator/workingMemory.ts` | 1 | 共享工作记忆 |
| `src/agents/structuredOutput.ts` | 2 | 结构化输出解析 |
| `src/lib/concurrency.ts` | 4 | 并行限流 Semaphore |
| `src/agents/agentTeam.ts` | 7 | Agent Team 定义 |
| `src/orchestrator/teamExecutor.ts` | 7 | Team 流水线执行引擎 |

---

## 附录 B：技术风险与缓解

| 风险 | 严重度 | 缓解方案 |
|------|--------|---------|
| LLM 不稳定产出结构化 JSON | 高 | Phase 2 采用 graceful degradation：提取失败时退回自由文本 |
| 并行 Sub-Agent 导致 API 限流 | 中 | Phase 4 使用 Semaphore 限制最大并发数；失败后自动降级为串行 |
| Working Memory 占用过多 token | 中 | Phase 1 强制 token 预算上限 + LRU 淘汰策略 |
| 特化 Agent 的 workflowTemplate 过长 | 低 | 设定模板最大 800 字符，超出自动截断 |
| Agent Team 流水线中间阶段失败导致整体阻塞 | 中 | Phase 7 提供 stop/skip/retry 三种 failurePolicy |
| checkpoint 恢复后 Working Memory 与文件系统不一致 | 低 | Phase 1 恢复后做 staleness 检查，清除过期条目 |

---

## 附录 C：与 Roadmap 的对齐

本计划的 Phase 1-5 对应 Roadmap 中 **"长期方向 — Sub-Agent 增强"**。Phase 6-7 是该条目的具体拆解。

建议将本计划的 Phase 1-2 合并入 **Milestone 5**（上下文管理与智能增强），Phase 3-5 作为 **Milestone 6.5**（Sub-Agent 增强专项），Phase 6-7 作为 **Milestone 8**（Agent Team）。

```
Milestone 5（当前规划）
├── 5.1 文件树概览注入 ← 已在 Roadmap
├── 5.2 多文件编辑原子性 ← 已在 Roadmap
├── 5.3 会话 context 压缩优化 ← 已在 Roadmap
├── 5.4 .cofreerc 配置 ← 已在 Roadmap
├── 5.5 共享工作记忆（Phase 1）← 本计划新增
└── 5.6 Sub-Agent 结构化输出（Phase 2）← 本计划新增

Milestone 6.5（新增）
├── 6.5.1 Sub-Agent 反馈与重试（Phase 3）
├── 6.5.2 并行 Sub-Agent 执行（Phase 4）
└── 6.5.3 流式进度上报（Phase 5）

Milestone 8（新增）
├── 8.1 特化 Agent 工作流（Phase 6）
└── 8.2 Agent Team 编排（Phase 7）
```
