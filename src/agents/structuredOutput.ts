/**
 * Cofree - AI Programming Cafe
 * File: src/agents/structuredOutput.ts
 * Description: Parse structured JSON output from sub-agent replies.
 * Only planner output and feedback signals are extracted.
 */

import type {
  SubAgentCompletionStatus,
  SubAgentFeedback,
  StructuredSubAgentOutput,
  PlannerOutput,
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
 * Attempt to extract structured planner output from a sub-agent's reply text.
 * Only planner role produces structured output; other roles return undefined.
 */
export function tryExtractStructuredOutput(
  role: string,
  reply: string,
): StructuredSubAgentOutput | undefined {
  if (role !== "planner") return undefined;

  const jsonBlock = extractJsonBlock(reply);
  if (!jsonBlock) return undefined;

  try {
    const parsed = JSON.parse(jsonBlock);
    if (!parsed || typeof parsed !== "object") return undefined;
    return validatePlannerOutput(parsed);
  } catch {
    return undefined;
  }
}

function extractJsonBlock(text: string): string | null {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  return match?.[1]?.trim() ?? null;
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

function normalizeComplexity(value: unknown): "low" | "medium" | "high" {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}
