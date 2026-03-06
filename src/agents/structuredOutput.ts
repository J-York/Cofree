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
  StructuredSubAgentOutput,
  PlannerOutput,
  CoderOutput,
  TesterOutput,
} from "./types";

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
