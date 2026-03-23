# Multi-Agent 质量重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Cofree 的多 Agent 体系从"角色扮演"升级为"对抗性验证"架构——精简 Agent 数量、引入上下文隔离、量化质量门禁、强制工具验证。

**Architecture:** 顶层 Agent 5→2，子 Agent 新增 verifier，Team 流水线 4→2，reviewer/verifier 阶段采用上下文隔离，质量门禁由代码逻辑计算（非 LLM 自判），修复轮通过内部循环函数实现。

**Tech Stack:** TypeScript, React 19, Vitest, Tauri 2.0

**Spec:** `docs/superpowers/specs/2026-03-23-multi-agent-quality-redesign.md`

---

### Task 1: 扩展类型定义（types.ts）

**Files:**
- Modify: `src/agents/types.ts:18` — SubAgentRole
- Modify: `src/agents/types.ts:81-97` — ReviewerOutput → ReviewOutput, 新增 VerifierOutput, 扩展 StructuredSubAgentOutput

- [ ] **Step 1: Write failing test — SubAgentRole includes "verifier"**

在 `tests/agentDomain.test.ts` 中添加：

```typescript
it("SubAgentRole type allows verifier", () => {
  const roles: SubAgentRole[] = ["planner", "coder", "tester", "debugger", "reviewer", "verifier"];
  expect(roles).toHaveLength(6);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/agentDomain.test.ts --run`
Expected: TypeScript compile error — `"verifier"` is not assignable to `SubAgentRole`

- [ ] **Step 3: Update SubAgentRole**

`src/agents/types.ts:18`:

```typescript
export type SubAgentRole = "planner" | "coder" | "tester" | "debugger" | "reviewer" | "verifier";
```

- [ ] **Step 4: Replace ReviewerOutput with ReviewOutput**

Replace `src/agents/types.ts:81-90` with:

```typescript
export interface ReviewOutput {
  dimensions: {
    correctness: { score: number; reasoning: string };
    security: { score: number; reasoning: string };
    maintainability: { score: number; reasoning: string };
    consistency: { score: number; reasoning: string };
  };
  issues: Array<{
    severity: "blocker" | "warning" | "suggestion";
    file: string;
    line?: number;
    message: string;
  }>;
}

/** @deprecated Use ReviewOutput */
export type ReviewerOutput = ReviewOutput;
```

- [ ] **Step 5: Add VerifierOutput**

After ReviewOutput, add:

```typescript
export interface VerifierOutput {
  commands: Array<{ cmd: string; exitCode: number; passed: boolean }>;
  allPassed: boolean;
  failureSummary: string;
}
```

- [ ] **Step 6: Extend StructuredSubAgentOutput**

Replace `src/agents/types.ts:92-97`:

```typescript
export type StructuredSubAgentOutput =
  | { role: "planner"; data: PlannerOutput }
  | { role: "coder"; data: CoderOutput }
  | { role: "tester"; data: TesterOutput }
  | { role: "debugger"; data: DebuggerOutput }
  | { role: "reviewer"; data: ReviewOutput }
  | { role: "verifier"; data: VerifierOutput };
```

- [ ] **Step 7: Run test and typecheck**

Run: `pnpm test -- tests/agentDomain.test.ts --run && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/agents/types.ts tests/agentDomain.test.ts
git commit -m "feat: extend types for verifier role and ReviewOutput dimensions"
```

---

### Task 2: 新增 verifier 子 Agent + 更新 reviewer schema（defaultAgents.ts）

**Files:**
- Modify: `src/agents/defaultAgents.ts:19-135`

- [ ] **Step 1: Update reviewer's outputSchemaHint**

Replace the existing reviewer entry's `outputSchemaHint` (lines ~123-133) with the new dimensions-based schema. Change severity `"critical"` to `"blocker"` in the prompt text:

```typescript
outputSchemaHint: [
  "完成审查后，请在回复末尾附上结构化输出：",
  "```json",
  "{",
  '  "dimensions": {',
  '    "correctness": {"score": 5, "reasoning": "..."},',
  '    "security": {"score": 4, "reasoning": "..."},',
  '    "maintainability": {"score": 4, "reasoning": "..."},',
  '    "consistency": {"score": 5, "reasoning": "..."}',
  "  },",
  '  "issues": [{"severity": "blocker|warning|suggestion", "file": "...", "line": 123, "message": "..."}]',
  "}",
  "```",
  "要求：每个维度评分 1-5（1=严重问题，5=优秀）。severity 使用 blocker（阻断级）、warning（需修改）、suggestion（建议性）。",
].join("\n"),
```

- [ ] **Step 2: Add verifier to DEFAULT_AGENTS array**

After the reviewer entry, add:

```typescript
{
  role: "verifier" as SubAgentRole,
  displayName: "Verifier",
  promptIntent: "Execute project test/lint/typecheck commands. Report pass/fail strictly based on exit codes. Never guess or assume results. Run the commands, observe the actual output, and report factually.",
  tools: ["propose_shell", "check_shell_job", "read_file", "glob"],
  sensitiveActionAllowed: false,
  allowAsSubAgent: true,
  subAgentMaxTurns: 10,
  outputSchemaHint: [
    "完成验证后，请在回复末尾附上结构化输出：",
    "```json",
    "{",
    '  "commands": [{"cmd": "pnpm test", "exitCode": 0, "passed": true}],',
    '  "allPassed": true,',
    '  "failureSummary": ""',
    "}",
    "```",
    "要求：commands 必须包含实际执行的每条命令及其真实退出码。allPassed 为 true 当且仅当所有 exitCode === 0。若有失败，failureSummary 需简述失败原因。",
  ].join("\n"),
},
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/agents/defaultAgents.ts
git commit -m "feat: add verifier sub-agent and update reviewer to dimensions-based schema"
```

---

### Task 3: 更新结构化输出解析（structuredOutput.ts）

**Files:**
- Modify: `src/agents/structuredOutput.ts:104-270`
- Test: `tests/structuredOutput.test.ts`

- [ ] **Step 1: Write failing test — validateReviewOutput with dimensions**

在 `tests/structuredOutput.test.ts` 中添加：

```typescript
it("parses reviewer output with dimensions scoring", () => {
  const reply = '```json\n{"dimensions":{"correctness":{"score":4,"reasoning":"ok"},"security":{"score":5,"reasoning":"ok"},"maintainability":{"score":3,"reasoning":"needs work"},"consistency":{"score":4,"reasoning":"ok"}},"issues":[{"severity":"blocker","file":"a.ts","line":10,"message":"bug"}]}\n```';
  const result = tryExtractStructuredOutput("reviewer", reply);
  expect(result).toBeDefined();
  expect(result!.role).toBe("reviewer");
  const data = result!.data as ReviewOutput;
  expect(data.dimensions.correctness.score).toBe(4);
  expect(data.issues[0].severity).toBe("blocker");
});

it("parses verifier output", () => {
  const reply = '```json\n{"commands":[{"cmd":"pnpm test","exitCode":0,"passed":true}],"allPassed":true,"failureSummary":""}\n```';
  const result = tryExtractStructuredOutput("verifier", reply);
  expect(result).toBeDefined();
  expect(result!.role).toBe("verifier");
  const data = result!.data as VerifierOutput;
  expect(data.allPassed).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/structuredOutput.test.ts --run`
Expected: FAIL

- [ ] **Step 3: Update normalizeSeverity**

Replace `normalizeSeverity` function:

```typescript
function normalizeSeverity(value: unknown): "blocker" | "warning" | "suggestion" {
  if (value === "blocker" || value === "warning" || value === "suggestion") return value;
  if (value === "critical") return "blocker";
  return "suggestion";
}
```

- [ ] **Step 4: Rewrite validateReviewerOutput → validateReviewOutput**

Replace the existing `validateReviewerOutput` function:

```typescript
function validateReviewOutput(
  data: Record<string, unknown>,
): StructuredSubAgentOutput | undefined {
  const dims = data.dimensions;
  if (!dims || typeof dims !== "object") return undefined;

  const dimRecord = dims as Record<string, unknown>;
  const requiredKeys = ["correctness", "security", "maintainability", "consistency"] as const;
  const dimensions: Record<string, { score: number; reasoning: string }> = {};

  for (const key of requiredKeys) {
    const d = dimRecord[key];
    if (!d || typeof d !== "object") return undefined;
    const entry = d as Record<string, unknown>;
    const rawScore = typeof entry.score === "number" ? entry.score : NaN;
    if (isNaN(rawScore)) return undefined;
    dimensions[key] = {
      score: Math.max(1, Math.min(5, Math.round(rawScore))),
      reasoning: typeof entry.reasoning === "string" ? entry.reasoning : "",
    };
  }

  const issues = Array.isArray(data.issues)
    ? (data.issues as Array<Record<string, unknown>>)
        .filter((i) => i && typeof i === "object")
        .map((i) => ({
          severity: normalizeSeverity(i.severity),
          file: String(i.file ?? ""),
          line: typeof i.line === "number" ? i.line : undefined,
          message: String(i.message ?? ""),
        }))
        .filter((i) => i.message.length > 0)
    : [];

  const output: ReviewOutput = {
    dimensions: dimensions as ReviewOutput["dimensions"],
    issues,
  };

  return { role: "reviewer", data: output };
}
```

- [ ] **Step 5: Add validateVerifierOutput**

```typescript
function validateVerifierOutput(
  data: Record<string, unknown>,
): StructuredSubAgentOutput | undefined {
  if (!Array.isArray(data.commands)) return undefined;

  const commands = (data.commands as Array<Record<string, unknown>>)
    .filter((c) => c && typeof c === "object")
    .map((c) => ({
      cmd: String(c.cmd ?? ""),
      exitCode: typeof c.exitCode === "number" ? c.exitCode : -1,
      passed: typeof c.passed === "boolean" ? c.passed : false,
    }))
    .filter((c) => c.cmd.length > 0);

  const output: VerifierOutput = {
    commands,
    allPassed: typeof data.allPassed === "boolean" ? data.allPassed : false,
    failureSummary: typeof data.failureSummary === "string" ? data.failureSummary : "",
  };

  return { role: "verifier", data: output };
}
```

- [ ] **Step 6: Update validateAndNormalize switch**

```typescript
case "reviewer":
  return validateReviewOutput(parsed);
case "verifier":
  return validateVerifierOutput(parsed);
```

- [ ] **Step 7: Update imports**

Update the import at top to use `ReviewOutput, VerifierOutput` instead of `ReviewerOutput`.

- [ ] **Step 8: Run tests**

Run: `pnpm test -- tests/structuredOutput.test.ts --run`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/agents/structuredOutput.ts tests/structuredOutput.test.ts
git commit -m "feat: rewrite reviewer output parsing for dimensions + add verifier parser"
```

---

### Task 4: Team 流水线重设计（agentTeam.ts）

**Files:**
- Modify: `src/agents/agentTeam.ts`
- Test: `tests/agentTeam.test.ts`

- [ ] **Step 1: Write failing test for new types and teams**

在 `tests/agentTeam.test.ts` 中添加：

```typescript
it("team-build and team-fix exist in BUILTIN_TEAMS", () => {
  const ids = BUILTIN_TEAMS.map((t) => t.id);
  expect(ids).toContain("team-build");
  expect(ids).toContain("team-fix");
});

it("team-build includes verifier stage with isolated contextPolicy", () => {
  const build = BUILTIN_TEAMS.find((t) => t.id === "team-build")!;
  const verifierStage = build.pipeline.find((s) => s.agentRole === "verifier");
  expect(verifierStage).toBeDefined();
  expect(verifierStage!.contextPolicy).toBe("isolated");
});

it("team-build reviewer has isolated contextPolicy", () => {
  const build = BUILTIN_TEAMS.find((t) => t.id === "team-build")!;
  const reviewerStage = build.pipeline.find((s) => s.agentRole === "reviewer");
  expect(reviewerStage).toBeDefined();
  expect(reviewerStage!.contextPolicy).toBe("isolated");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/agentTeam.test.ts --run`
Expected: FAIL

- [ ] **Step 3: Extend AgentTeamStage and condition types**

Add to `AgentTeamStage` interface:

```typescript
contextPolicy?: "shared" | "isolated";
isolatedInputs?: IsolatedInputSpec;
maxRepairRounds?: number;
```

Add new interface:

```typescript
export interface IsolatedInputSpec {
  fromOriginalRequest: boolean;
  fromStage?: string;
  fields?: string[];
  includeGitDiff?: boolean;
  includeFileContents?: string[];
}
```

Extend `AgentTeamStageConditionType`:

```typescript
export type AgentTeamStageConditionType =
  | "always"
  | "if_previous_succeeded"
  | "if_issues_found"
  | "if_issues_from_stage"
  | "if_stage_executed"
  | "if_review_failed"
  | "if_verify_failed";
```

Extend `TeamStopReason` (in `teamExecutor.ts` — but the type reference here):

Add `"quality_gate_failed"` to `TeamStopReason` in `teamExecutor.ts`.

- [ ] **Step 4: Replace BUILTIN_TEAMS with new 2 pipelines**

Replace the entire `BUILTIN_TEAMS` array with `team-build` and `team-fix` definitions as specified in the design spec (Section 4.1 and 4.2). Copy the exact pipeline definitions from the spec.

- [ ] **Step 5: Add legacy team ID compat mapping**

```typescript
const LEGACY_TEAM_ID_MAP: Record<string, string> = {
  "team-full-cycle": "team-build",
  "team-expert-panel": "team-build",
  "team-expert-panel-v2": "team-build",
  "team-debug-fix": "team-fix",
};

export function resolveTeamId(id: string): string {
  return LEGACY_TEAM_ID_MAP[id] ?? id;
}
```

- [ ] **Step 6: Run tests**

Run: `pnpm test -- tests/agentTeam.test.ts --run`
Expected: PASS (new tests), some old tests may need updating for removed team IDs

- [ ] **Step 7: Fix any broken tests referencing old team IDs**

Update test expectations that reference `team-expert-panel`, `team-full-cycle`, etc. to use new IDs or use `resolveTeamId`.

- [ ] **Step 8: Commit**

```bash
git add src/agents/agentTeam.ts tests/agentTeam.test.ts
git commit -m "feat: redesign team pipelines to team-build and team-fix with context isolation"
```

---

### Task 5: Team 执行器核心改动（teamExecutor.ts）

**Files:**
- Modify: `src/orchestrator/teamExecutor.ts:16-20, 55-79, 309-542`
- Test: `tests/agentTeam.test.ts` (executor tests are here)

- [ ] **Step 1: Write failing test — computeReviewVerdict**

```typescript
describe("computeReviewVerdict", () => {
  it("returns fail when any dimension score <= 2", () => {
    const output = makeDimensionsOutput({ correctness: 2, security: 5, maintainability: 5, consistency: 5 });
    expect(computeReviewVerdict(output)).toBe("fail");
  });

  it("returns fail when blocker issue exists", () => {
    const output = makeDimensionsOutput({ correctness: 5, security: 5, maintainability: 5, consistency: 5 });
    output.issues = [{ severity: "blocker", file: "a.ts", message: "critical bug" }];
    expect(computeReviewVerdict(output)).toBe("fail");
  });

  it("returns fail when correctness <= 3", () => {
    const output = makeDimensionsOutput({ correctness: 3, security: 5, maintainability: 5, consistency: 5 });
    expect(computeReviewVerdict(output)).toBe("fail");
  });

  it("returns pass when all dimensions good and no blockers", () => {
    const output = makeDimensionsOutput({ correctness: 4, security: 4, maintainability: 4, consistency: 4 });
    expect(computeReviewVerdict(output)).toBe("pass");
  });
});
```

- [ ] **Step 2: Write failing test — computeVerifyVerdict**

```typescript
describe("computeVerifyVerdict", () => {
  it("returns pass when all commands exit 0", () => {
    expect(computeVerifyVerdict({ commands: [{ cmd: "test", exitCode: 0, passed: true }], allPassed: true, failureSummary: "" })).toBe("pass");
  });

  it("returns fail when any command exits non-zero", () => {
    expect(computeVerifyVerdict({ commands: [{ cmd: "test", exitCode: 1, passed: false }], allPassed: false, failureSummary: "test failed" })).toBe("fail");
  });

  it("returns fail when no commands", () => {
    expect(computeVerifyVerdict({ commands: [], allPassed: true, failureSummary: "" })).toBe("fail");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- tests/agentTeam.test.ts --run`
Expected: FAIL — functions don't exist yet

- [ ] **Step 4: Extend TeamStopReason**

```typescript
export type TeamStopReason =
  | "completed_normal"
  | "budget_exhausted"
  | "aborted"
  | "stage_failed"
  | "quality_gate_failed";
```

- [ ] **Step 5: Add verdict to SubAgentResult**

In `src/orchestrator/planningService.ts`, add to `SubAgentResult`:

```typescript
export interface SubAgentResult {
  // ...existing fields...
  verdict?: "pass" | "fail";
}
```

- [ ] **Step 6: Implement computeReviewVerdict and computeVerifyVerdict**

Export from `teamExecutor.ts`:

```typescript
export function computeReviewVerdict(output: ReviewOutput): "pass" | "fail" {
  const dims = output.dimensions;
  const scores = [dims.correctness, dims.security, dims.maintainability, dims.consistency];
  if (scores.some(d => d.score <= 2)) return "fail";
  if (output.issues.some(i => i.severity === "blocker")) return "fail";
  if (dims.correctness.score <= 3) return "fail";
  return "pass";
}

export function computeVerifyVerdict(output: VerifierOutput): "pass" | "fail" {
  if (!output.commands || output.commands.length === 0) return "fail";
  return output.commands.every(c => c.exitCode === 0) ? "pass" : "fail";
}
```

- [ ] **Step 7: Extend evaluateStageCondition**

Add cases:

```typescript
case "if_review_failed":
case "if_verify_failed": {
  const ref = condition.refStageLabel;
  if (!ref) return false;
  const res = stageResults.get(ref);
  return res?.verdict === "fail";
}
```

- [ ] **Step 8: Implement assembleIsolatedContext**

Add internal function:

```typescript
import { execSync } from "child_process";

function assembleIsolatedContext(
  spec: IsolatedInputSpec,
  taskDescription: string,
  workspacePath: string,
  stageResults: Map<string, SubAgentResult>,
): string {
  const sections: string[] = [];

  if (spec.fromOriginalRequest) {
    sections.push(`## 原始需求\n\n${taskDescription}`);
  }

  if (spec.includeGitDiff) {
    try {
      const diff = execSync("git diff HEAD", { cwd: workspacePath, encoding: "utf-8", timeout: 10000 });
      if (diff.trim()) {
        sections.push(`## 代码变更 (git diff)\n\n\`\`\`diff\n${diff}\n\`\`\``);
      }
    } catch { /* ignore git errors */ }
  }

  if (spec.includeFileContents?.length) {
    // "changed" → parse git diff for file list; specific paths → read directly
    // Implementation: use git diff --name-only, then fs.readFileSync for each
    // ... (full implementation in code)
  }

  if (spec.fromStage && spec.fields?.length) {
    const stageResult = stageResults.get(spec.fromStage);
    if (stageResult?.structuredOutput) {
      const data = stageResult.structuredOutput.data as Record<string, unknown>;
      const subset: Record<string, unknown> = {};
      for (const f of spec.fields) {
        if (f in data) subset[f] = data[f];
      }
      sections.push(`## 上游阶段输出（${spec.fromStage}）\n\n\`\`\`json\n${JSON.stringify(subset, null, 2)}\n\`\`\``);
    }
  }

  return sections.join("\n\n---\n\n");
}
```

- [ ] **Step 9: Update resolveStageMemory for contextPolicy**

Modify the existing `resolveStageMemory` in `executeAgentTeam` to check `stage.contextPolicy === "isolated"` — when isolated, return `undefined` for working memory (the isolated context is injected separately as system message appendix).

- [ ] **Step 10: Implement executeRepairLoop**

```typescript
async function executeRepairLoop(params: {
  repairStage: AgentTeamStage;
  verifyStage: AgentTeamStage;
  maxRounds: number;
  // ...other execution params
}): Promise<{ repairCount: number; finalVerdict: "pass" | "fail" }> {
  let repairCount = 0;
  while (repairCount < params.maxRounds) {
    // 1. Execute repair (coder) stage
    // 2. Re-execute verify stage (isolated context)
    // 3. Compute verdict
    // 4. If pass → break; if fail → repairCount++
    repairCount++;
  }
  return { repairCount, finalVerdict };
}
```

- [ ] **Step 11: Integrate into main loop**

In `executeAgentTeam`'s main loop, when encountering a stage with `maxRepairRounds`, call `executeRepairLoop` instead of the normal single-execution path. The repair loop handles the coder-fix → re-verify cycle internally.

- [ ] **Step 12: Compute and store verdict after reviewer/verifier stages**

After `executeStage` for reviewer or verifier roles, extract `structuredOutput`, compute verdict via `computeReviewVerdict` / `computeVerifyVerdict`, and store in `result.verdict`.

- [ ] **Step 13: Run all tests**

Run: `pnpm test -- tests/agentTeam.test.ts --run`
Expected: PASS

- [ ] **Step 14: Commit**

```bash
git add src/orchestrator/teamExecutor.ts src/orchestrator/planningService.ts tests/agentTeam.test.ts
git commit -m "feat: context isolation, verdict computation, and repair loops in team executor"
```

---

### Task 6: 顶层 Agent 精简（builtinChatAgents.ts）

**Files:**
- Modify: `src/agents/builtinChatAgents.ts:14-137`
- Test: `tests/agentDomain.test.ts`

- [ ] **Step 1: Write failing test for new agents**

```typescript
it("has exactly 2 builtin agents", () => {
  expect(BUILTIN_CHAT_AGENTS).toHaveLength(2);
});

it("default agent is agent-general", () => {
  expect(DEFAULT_CHAT_AGENT_ID).toBe("agent-general");
});

it("agent-general has all tools and parallel handoff", () => {
  const agent = getBuiltinChatAgent("agent-general")!;
  expect(agent.handoffPolicy).toBe("parallel");
  expect(agent.allowedSubAgents).toContain("verifier");
});

it("agent-orchestrator has no propose_ tools", () => {
  const agent = getBuiltinChatAgent("agent-orchestrator")!;
  expect(agent.toolPolicy.enabledTools).toBeDefined();
  expect(agent.toolPolicy.enabledTools).not.toContain("propose_file_edit");
  expect(agent.toolPolicy.enabledTools).not.toContain("propose_shell");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/agentDomain.test.ts --run`
Expected: FAIL

- [ ] **Step 3: Replace BUILTIN_CHAT_AGENTS**

Replace the entire array with 2 agents:

```typescript
export const BUILTIN_CHAT_AGENTS: ChatAgentDefinition[] = [
  {
    id: "agent-general",
    name: "通用 Agent",
    description: "默认 Agent，可阅读代码、提出编辑、执行命令并委派子任务。适合大多数场景。",
    icon: "code",
    systemPromptTemplate: [
      "你是 Cofree 的通用 AI 编程助手。",
      "行为准则：",
      "1. 深刻理解需求，阅读代码收集完整上下文后再行动。",
      "2. 产出高质量代码：健壮、高效、优雅、符合项目一致性。",
      "3. 系统性排查问题：基于证据形成假设，逐一验证，而非猜测。",
      "4. 交付前自我验证：改完代码后主动检查 lint、类型、测试。",
      "5. 保持清晰沟通：多步操作中提供简短进度同步（1-3句话）。",
    ].join("\n"),
    toolPolicy: {},
    useGlobalModel: true,
    allowedSubAgents: ["planner", "coder", "tester", "debugger", "reviewer", "verifier"],
    handoffPolicy: "parallel",
    builtin: true,
  },
  {
    id: "agent-orchestrator",
    name: "编排 Agent",
    description: "不动手只编排：理解需求后委派给子角色或 Team 流水线，汇总结论交付给用户。",
    icon: "layers",
    systemPromptTemplate: [
      "你是 Cofree 的编排 Agent，用户面对的是一个虚拟专家团。",
      "职责：",
      "1. 快速理解用户目标、约束与成功标准；必要时用只读工具补充上下文。",
      "2. 将工作委派给合适的 Team 或子角色：新功能/重构用 task(team='team-build')；bug 修复用 task(team='team-fix')；简单单步问题用 task(role=...)。",
      "3. 委派前用一两句话说明将由哪条流水线负责；结束后用清晰结构汇总交付物、风险与待确认点。",
      "4. 不要独自完成大段实现——你的价值是编排与对齐，专家角色负责执行。",
      "5. 保持回复可扫读：短段落、列表优先。",
    ].join("\n"),
    toolPolicy: {
      enabledTools: [
        "list_files", "read_file", "grep", "glob",
        "git_status", "git_diff", "diagnostics", "fetch",
      ],
    },
    useGlobalModel: true,
    allowedSubAgents: ["planner", "coder", "tester", "debugger", "reviewer", "verifier"],
    handoffPolicy: "sequential",
    builtin: true,
  },
];

export const DEFAULT_CHAT_AGENT_ID = "agent-general";
```

- [ ] **Step 4: Fix remaining tests referencing old agent IDs**

Update test expectations: `agent-fullstack` → `agent-general`, etc. Tests checking for 5 agents → 2.

- [ ] **Step 5: Run tests**

Run: `pnpm test -- tests/agentDomain.test.ts --run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/agents/builtinChatAgents.ts tests/agentDomain.test.ts
git commit -m "feat: simplify top-level agents from 5 to 2 (general + orchestrator)"
```

---

### Task 7: Runtime 解析和 Prompt 适配

**Files:**
- Modify: `src/agents/resolveAgentRuntime.ts`
- Modify: `src/agents/promptAssembly.ts`
- Test: `src/agents/resolveAgentRuntime.test.ts`

- [ ] **Step 1: Update resolveAgentRuntime.test.ts**

Replace references to old agent IDs (`agent-fullstack` → `agent-general`, etc.). Ensure the default fallback test still works.

- [ ] **Step 2: Run test to check baseline**

Run: `pnpm test -- src/agents/resolveAgentRuntime.test.ts --run`

- [ ] **Step 3: Update promptAssembly.ts if needed**

Check `assembleSystemPrompt` and `assembleRuntimeContext` for any hardcoded references to old agent IDs or old team IDs. Update as needed. Ensure `allowedSubAgents` in context now includes `"verifier"`.

- [ ] **Step 4: Run full test suite**

Run: `pnpm test --run`
Expected: PASS (except known planningService.test.ts failures)

- [ ] **Step 5: Commit**

```bash
git add src/agents/resolveAgentRuntime.ts src/agents/resolveAgentRuntime.test.ts src/agents/promptAssembly.ts
git commit -m "feat: adapt runtime resolver and prompt assembly for new agent IDs"
```

---

### Task 8: planningService 适配

**Files:**
- Modify: `src/orchestrator/planningService.ts`
- Test: `src/orchestrator/planningService.test.ts`

- [ ] **Step 1: Search for hardcoded old agent/team IDs**

Search `planningService.ts` for: `agent-fullstack`, `agent-concierge`, `agent-code-reviewer`, `agent-architect`, `agent-qa`, `team-expert-panel`, `team-full-cycle`, `team-debug-fix`. Replace with new IDs or use `resolveTeamId`.

- [ ] **Step 2: Ensure executeSubAgentTask handles verifier role**

Verify that `executeSubAgentTask` at line ~3551 (`DEFAULT_AGENTS.find`) will find verifier now that it's in the array. No code change needed if the find is role-based (it is).

- [ ] **Step 3: Search for "critical" severity references**

Search planningService.ts for string `"critical"` and update to `"blocker"` where it's referencing issue severity.

- [ ] **Step 4: Update planningService.test.ts**

Replace old agent/team ID references. Update test expectations.

- [ ] **Step 5: Run tests**

Run: `pnpm test -- src/orchestrator/planningService.test.ts --run`
Expected: PASS (except known 2 pre-existing failures)

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/planningService.ts src/orchestrator/planningService.test.ts
git commit -m "feat: adapt planningService for new agent/team IDs and verifier role"
```

---

### Task 9: UI 适配

**Files:**
- Modify: `src/ui/components/TitleBar.tsx` — Agent 选择器
- Modify: `src/ui/pages/ChatPage.tsx` — Team 相关文案
- Modify: `src/ui/pages/chat/expertStageMessages.ts` — 阶段标签

- [ ] **Step 1: Update TitleBar.tsx**

Search for references to old agent names/IDs. The selector should now show 2 agents. No structural change needed if it dynamically reads from `getAllChatAgents`.

- [ ] **Step 2: Update expertStageMessages.ts**

Search for hardcoded old stage labels (e.g. `"需求对齐与任务拆解"`, `"实现与落地"`, `"审查与质量把关"`). Update to new labels (`"需求分析"`, `"实现"`, `"代码审查"`, `"最终验证"`, etc.) or make it dynamic from team pipeline.

- [ ] **Step 3: Update ChatPage.tsx**

Search for old team IDs and update references. Check `team-expert-panel` / `team-expert-panel-v2` references.

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/TitleBar.tsx src/ui/pages/ChatPage.tsx src/ui/pages/chat/expertStageMessages.ts
git commit -m "feat: adapt UI for simplified agents and new team pipelines"
```

---

### Task 10: 集成测试与最终验证

**Files:**
- All test files

- [ ] **Step 1: Run full test suite**

Run: `pnpm test --run`
Expected: All pass except known 2 pre-existing failures in `planningService.test.ts`

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Fix any remaining failures**

Address any test or type errors found.

- [ ] **Step 4: Run dev server smoke test**

Run: `pnpm dev`
Verify: Frontend starts on port 1420 without errors.

- [ ] **Step 5: Final commit if needed**

```bash
git add -A
git commit -m "fix: resolve integration issues from multi-agent redesign"
```
