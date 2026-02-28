/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/checkpointStore.ts
 * Milestone: 3
 * Task: 3.6
 * Status: In Progress
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: SQLite-backed workflow checkpoint helpers through Tauri commands.
 */

import { invoke } from "@tauri-apps/api/core";
import type { OrchestrationPlan } from "./types";
import { normalizeOrchestrationPlan } from "./planGuards";
import type { ToolErrorCategory, ToolExecutionTrace } from "./planningService";

export const CHAT_SESSION_ID = "default-chat-session";

interface CheckpointRecord {
  checkpoint_id: string;
  session_id: string;
  message_id: string;
  workflow_state: string;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

interface RecoveryResult {
  found: boolean;
  checkpoint: CheckpointRecord | null;
}

export interface WorkflowCheckpointPayload {
  plan: OrchestrationPlan;
  toolTrace?: ToolExecutionTrace[];
}

function isToolErrorCategory(value: unknown): value is ToolErrorCategory {
  return (
    value === "validation" ||
    value === "workspace" ||
    value === "permission" ||
    value === "timeout" ||
    value === "allowlist" ||
    value === "transport" ||
    value === "tool_not_found" ||
    value === "unknown"
  );
}

function normalizeToolTrace(value: unknown): ToolExecutionTrace[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: ToolExecutionTrace[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.callId !== "string" ||
      typeof record.name !== "string" ||
      typeof record.arguments !== "string" ||
      typeof record.startedAt !== "string" ||
      typeof record.finishedAt !== "string" ||
      typeof record.attempts !== "number" ||
      (record.status !== "success" && record.status !== "failed") ||
      typeof record.retried !== "boolean"
    ) {
      continue;
    }

    normalized.push({
      callId: record.callId,
      name: record.name,
      arguments: record.arguments,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      attempts: record.attempts,
      status: record.status,
      retried: record.retried,
      errorCategory: isToolErrorCategory(record.errorCategory) ? record.errorCategory : undefined,
      errorMessage: typeof record.errorMessage === "string" ? record.errorMessage : undefined,
      resultPreview: typeof record.resultPreview === "string" ? record.resultPreview : undefined
    });

    if (normalized.length >= 80) {
      break;
    }
  }

  return normalized;
}

export async function saveWorkflowCheckpoint(
  sessionId: string,
  messageId: string,
  plan: OrchestrationPlan,
  toolTrace: ToolExecutionTrace[] = []
): Promise<void> {
  const payload: WorkflowCheckpointPayload = { plan, toolTrace };
  await invoke("save_workflow_checkpoint", {
    sessionId,
    messageId,
    workflowState: plan.state,
    payloadJson: JSON.stringify(payload)
  });
}

export async function loadLatestWorkflowCheckpoint(
  sessionId: string
): Promise<{ messageId: string; payload: WorkflowCheckpointPayload } | null> {
  const result = await invoke<RecoveryResult>("load_latest_workflow_checkpoint", {
    sessionId
  });
  if (!result.found || !result.checkpoint) {
    return null;
  }

  const parsed = JSON.parse(result.checkpoint.payload_json) as Partial<WorkflowCheckpointPayload>;
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const normalizedPlan = normalizeOrchestrationPlan(parsed.plan);
  if (!normalizedPlan) {
    return null;
  }

  return {
    messageId: result.checkpoint.message_id,
    payload: {
      plan: normalizedPlan,
      toolTrace: normalizeToolTrace(parsed.toolTrace)
    }
  };
}
