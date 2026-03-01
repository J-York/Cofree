/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/planGuards.ts
 * Milestone: 3
 * Task: 3.6
 * Status: In Progress
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Runtime guards for restoring orchestration plans from local persistence.
 */

import type { ActionProposal, OrchestrationPlan } from "./types";

const WORKFLOW_STATES = new Set<OrchestrationPlan["state"]>([
  "planning",
  "executing",
  "human_review",
  "done"
]);

const ACTION_STATUSES = new Set<ActionProposal["status"]>([
  "pending",
  "running",
  "completed",
  "failed",
  "rejected"
]);

const STEP_OWNERS = new Set(["planner", "coder", "tester"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeActionStatus(value: unknown): ActionProposal["status"] {
  if (typeof value === "string" && ACTION_STATUSES.has(value as ActionProposal["status"])) {
    return value as ActionProposal["status"];
  }
  return "pending";
}

function normalizeExecutionResult(
  value: unknown
): ActionProposal["executionResult"] | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  if (typeof record.success !== "boolean" || typeof record.message !== "string") {
    return undefined;
  }

  return {
    success: record.success,
    message: record.message,
    timestamp: asString(record.timestamp, new Date().toISOString()),
    metadata: asRecord(record.metadata) ?? undefined
  };
}

function normalizeAction(value: unknown, index: number): ActionProposal | null {
  const record = asRecord(value);
  if (!record || typeof record.type !== "string") {
    return null;
  }

  const id = asString(record.id, `action-${index + 1}`);
  const description = asString(record.description, "Pending action");
  const status = normalizeActionStatus(record.status);
  const executed = asBoolean(record.executed, status === "completed");
  const executionResult = normalizeExecutionResult(record.executionResult);
  const payload = asRecord(record.payload) ?? {};

  if (record.type === "apply_patch") {
    return {
      id,
      type: "apply_patch",
      description,
      gateRequired: true,
      status,
      executed,
      executionResult,
      payload: {
        patch: asString(payload.patch, "")
      }
    };
  }

  // Backward compatibility: convert run_command to shell
  if (record.type === "run_command") {
    const command = asString(payload.command, "pnpm");
    const args = Array.isArray(payload.args)
      ? payload.args.map((arg) => typeof arg === "string" ? arg : "").filter(Boolean)
      : ["build"];
    const shellCommand = [command, ...args].join(" ");
    return {
      id,
      type: "shell",
      description,
      gateRequired: true,
      status,
      executed,
      executionResult,
      payload: {
        shell: shellCommand,
        timeoutMs: Math.max(1000, asNumber(payload.timeoutMs, 120000))
      }
    };
  }

  // Backward compatibility: convert git_write to shell
  if (record.type === "git_write") {
    const operation = asString(payload.operation, "stage");
    const message = asString(payload.message, "chore: apply approved changes");
    const branchName = asString(payload.branchName, "cofree/m3-approved");

    let shellCommand = "";
    if (operation === "stage") {
      shellCommand = "git add .";
    } else if (operation === "commit") {
      shellCommand = `git commit -m "${message.replace(/"/g, '\\"')}"`;
    } else if (operation === "checkout_branch") {
      shellCommand = `git checkout -b ${branchName}`;
    }

    return {
      id,
      type: "shell",
      description,
      gateRequired: true,
      status,
      executed,
      executionResult,
      payload: {
        shell: shellCommand,
        timeoutMs: 120000
      }
    };
  }

  if (record.type === "shell") {
    return {
      id,
      type: "shell",
      description,
      gateRequired: true,
      status,
      executed,
      executionResult,
      payload: {
        shell: asString(payload.shell, "pnpm build"),
        timeoutMs: Math.max(1000, asNumber(payload.timeoutMs, 120000))
      }
    };
  }

  return null;
}

export function normalizeOrchestrationPlan(value: unknown): OrchestrationPlan | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const stateCandidate = asString(record.state, "planning");
  const state = WORKFLOW_STATES.has(stateCandidate as OrchestrationPlan["state"])
    ? (stateCandidate as OrchestrationPlan["state"])
    : "planning";

  const prompt = asString(record.prompt, "恢复的工作流");

  const rawSteps = Array.isArray(record.steps) ? record.steps : [];
  const steps = rawSteps
    .map((step, index) => {
      const stepRecord = asRecord(step);
      if (!stepRecord) {
        return null;
      }
      const ownerCandidate = asString(stepRecord.owner, "planner");
      const owner = STEP_OWNERS.has(ownerCandidate) ? ownerCandidate : "planner";
      const summary = asString(stepRecord.summary, "").trim();
      if (!summary) {
        return null;
      }
      return {
        id: asString(stepRecord.id, `step-${index + 1}`),
        summary,
        owner: owner as OrchestrationPlan["steps"][number]["owner"]
      };
    })
    .filter((step): step is OrchestrationPlan["steps"][number] => Boolean(step));

  const rawActions = Array.isArray(record.proposedActions) ? record.proposedActions : [];
  const proposedActions = rawActions
    .map((action, index) => normalizeAction(action, index))
    .filter((action): action is ActionProposal => Boolean(action));

  return {
    state,
    prompt,
    steps,
    proposedActions,
    workspacePath: typeof record.workspacePath === "string" ? record.workspacePath : undefined
  };
}
