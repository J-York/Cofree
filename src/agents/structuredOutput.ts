/**
 * Cofree - AI Programming Cafe
 * File: src/agents/structuredOutput.ts
 * Description: Parse and validate structured JSON output from sub-agent replies.
 *
 * Strategy: extract ```json ... ``` blocks from the reply text, then validate
 * against role-specific schemas. Falls back to undefined on any parse failure
 * (graceful degradation).
 */

import type {
  SubAgentRole,
  SubAgentCompletionStatus,
  SubAgentFeedback,
  StructuredSubAgentOutput,
  PlannerOutput,
  CoderOutput,
  TesterOutput,
  DebuggerOutput,
  ReviewOutput,
  VerifierOutput,
} from "./types";

/**
 * Attempt to extract feedback/status signals from a sub-agent's reply.
 * The sub-agent may embed a JSON block with "status" field to signal
 * need_clarification, blocked, or partial completion.
 */
export function tryExtractFeedback(
  reply: string,
): { status: SubAgentCompletionStatus; feedback?: SubAgentFeedback } | undefined {
  const jsonBlock = extractJsonBlock(reply);
  if (!jsonBlock) return undefined;

  try {
    const parsed = JSON.parse(jsonBlock);
    if (!parsed || typeof parsed !== "object") return undefined;

    const status = parsed.status;
    if (!isSubAgentStatus(status)) return undefined;
    if (status === "completed") return undefined;

    const feedback: SubAgentFeedback = {
      reason: typeof parsed.reason === "string" ? parsed.reason : "未提供原因",
      missingContext: Array.isArray(parsed.missingContext)
        ? parsed.missingContext.map(String)
        : undefined,
      suggestedAction: typeof parsed.suggestedAction === "string"
        ? parsed.suggestedAction
        : undefined,
      blockedBy: typeof parsed.blockedBy === "string"
        ? parsed.blockedBy
        : undefined,
    };

    return { status, feedback };
  } catch {
    return undefined;
  }
}

function isSubAgentStatus(value: unknown): value is SubAgentCompletionStatus {
  return (
    value === "completed" ||
    value === "partial" ||
    value === "need_clarification" ||
    value === "blocked" ||
    value === "failed" ||
    value === "skipped"
  );
}

/**
 * Attempt to extract structured output from a sub-agent's reply text.
 * Returns undefined if no valid JSON block is found or validation fails.
 */
export function tryExtractStructuredOutput(
  role: SubAgentRole,
  reply: string,
): StructuredSubAgentOutput | undefined {
  const jsonBlock = extractJsonBlock(reply);
  if (!jsonBlock) return undefined;

  try {
    const parsed = JSON.parse(jsonBlock);
    if (!parsed || typeof parsed !== "object") return undefined;
    return validateAndNormalize(role, parsed);
  } catch {
    return undefined;
  }
}

/**
 * Extract the first ```json ... ``` fenced code block from text.
 */
function extractJsonBlock(text: string): string | null {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  return match?.[1]?.trim() ?? null;
}

// ---------------------------------------------------------------------------
// Role-specific validation
// ---------------------------------------------------------------------------

function validateAndNormalize(
  role: SubAgentRole,
  parsed: Record<string, unknown>,
): StructuredSubAgentOutput | undefined {
  switch (role) {
    case "planner":
      return validatePlannerOutput(parsed);
    case "coder":
      return validateCoderOutput(parsed);
    case "tester":
      return validateTesterOutput(parsed);
    case "debugger":
      return validateDebuggerOutput(parsed);
    case "reviewer":
      return validateReviewOutput(parsed);
    case "verifier":
      return validateVerifierOutput(parsed);
    default:
      return undefined;
  }
}

function validatePlannerOutput(
  data: Record<string, unknown>,
): StructuredSubAgentOutput | undefined {
  if (!Array.isArray(data.tasks)) return undefined;

  const tasks = data.tasks
    .filter((t): t is Record<string, unknown> => t && typeof t === "object")
    .map((t) => ({
      title: String(t.title ?? ""),
      description: String(t.description ?? ""),
      targetFiles: Array.isArray(t.targetFiles) ? t.targetFiles.map(String) : [],
      estimatedComplexity: normalizeComplexity(t.estimatedComplexity),
      dependencies: Array.isArray(t.dependencies) ? t.dependencies.map(String) : undefined,
    }))
    .filter((t) => t.title.length > 0);

  if (tasks.length === 0) return undefined;

  const output: PlannerOutput = {
    tasks,
    riskAssessment: typeof data.riskAssessment === "string" ? data.riskAssessment : undefined,
    architectureNotes: typeof data.architectureNotes === "string" ? data.architectureNotes : undefined,
  };

  return { role: "planner", data: output };
}

function validateCoderOutput(
  data: Record<string, unknown>,
): StructuredSubAgentOutput | undefined {
  const summary = typeof data.summary === "string" ? data.summary : "";
  if (!summary) return undefined;

  const output: CoderOutput = {
    changedFiles: Array.isArray(data.changedFiles) ? data.changedFiles.map(String) : [],
    summary,
    implementationNotes: typeof data.implementationNotes === "string" ? data.implementationNotes : undefined,
    knownIssues: Array.isArray(data.knownIssues) ? data.knownIssues.map(String) : undefined,
  };

  return { role: "coder", data: output };
}

function validateTesterOutput(
  data: Record<string, unknown>,
): StructuredSubAgentOutput | undefined {
  if (!Array.isArray(data.testPlan)) return undefined;

  const testPlan = data.testPlan
    .filter((t): t is Record<string, unknown> => t && typeof t === "object")
    .map((t) => ({
      testCase: String(t.testCase ?? ""),
      steps: Array.isArray(t.steps) ? t.steps.map(String) : [],
      expectedResult: String(t.expectedResult ?? ""),
      actualResult: typeof t.actualResult === "string" ? t.actualResult : undefined,
      passed: typeof t.passed === "boolean" ? t.passed : undefined,
    }))
    .filter((t) => t.testCase.length > 0);

  if (testPlan.length === 0) return undefined;

  const output: TesterOutput = {
    testPlan,
    riskLevel: normalizeRiskLevel(data.riskLevel),
    coverageGaps: Array.isArray(data.coverageGaps) ? data.coverageGaps.map(String) : undefined,
  };

  return { role: "tester", data: output };
}

function validateDebuggerOutput(
  data: Record<string, unknown>,
): StructuredSubAgentOutput | undefined {
  if (!Array.isArray(data.hypotheses)) return undefined;

  const hypotheses = data.hypotheses
    .filter((h): h is Record<string, unknown> => h && typeof h === "object")
    .map((h) => ({
      description: String(h.description ?? ""),
      evidence: String(h.evidence ?? ""),
      status: normalizeHypothesisStatus(h.status),
    }))
    .filter((h) => h.description.length > 0);

  const output: DebuggerOutput = {
    hypotheses,
    rootCause: typeof data.rootCause === "string" ? data.rootCause : undefined,
    fix: typeof data.fix === "string" ? data.fix : undefined,
  };

  return { role: "debugger", data: output };
}

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeComplexity(value: unknown): "low" | "medium" | "high" {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}

function normalizeRiskLevel(value: unknown): "low" | "medium" | "high" {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}

function normalizeHypothesisStatus(value: unknown): "confirmed" | "rejected" | "pending" {
  if (value === "confirmed" || value === "rejected" || value === "pending") return value;
  return "pending";
}

function normalizeSeverity(value: unknown): "blocker" | "warning" | "suggestion" {
  if (value === "blocker" || value === "warning" || value === "suggestion") return value;
  if (value === "critical") return "blocker";
  return "suggestion";
}
