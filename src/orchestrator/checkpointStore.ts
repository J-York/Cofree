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
import { redactSensitiveText, sanitizeForPersistence } from "../lib/redaction";
import { normalizeOrchestrationPlan } from "./planGuards";
import type { ToolErrorCategory, ToolExecutionTrace } from "./planningService";

const CHAT_SESSION_KEY = "cofree.chat.session.v1";

export function getChatSessionId(): string {
  if (typeof window === "undefined") return "default-chat-session";
  let sessionId = window.localStorage.getItem(CHAT_SESSION_KEY);
  if (!sessionId) {
    sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    window.localStorage.setItem(CHAT_SESSION_KEY, sessionId);
  }
  return sessionId;
}

export function resetChatSessionId(): string {
  if (typeof window === "undefined") return "default-chat-session";
  const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  window.localStorage.setItem(CHAT_SESSION_KEY, sessionId);
  return sessionId;
}

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

function sanitizeToolTraceForCheckpoint(toolTrace: ToolExecutionTrace[]): ToolExecutionTrace[] {
  return toolTrace.slice(-20).map((trace) => ({
    ...trace,
    arguments: redactSensitiveText(trace.arguments, 240),
    errorMessage: trace.errorMessage ? redactSensitiveText(trace.errorMessage, 240) : undefined,
    resultPreview: trace.resultPreview ? redactSensitiveText(trace.resultPreview, 240) : undefined
  }));
}

function sanitizePlanForCheckpoint(plan: OrchestrationPlan): OrchestrationPlan {
  return {
    ...plan,
    prompt: redactSensitiveText(plan.prompt, 400),
    proposedActions: plan.proposedActions.map((action) => {
      const shouldRetainPatchBody =
        action.type === "apply_patch" &&
        (action.status === "pending" || action.status === "running" || action.status === "failed");

      if (action.type === "apply_patch") {
        return {
          ...action,
          executionResult: action.executionResult
            ? {
                ...action.executionResult,
                message: redactSensitiveText(action.executionResult.message, 240),
                metadata: (sanitizeForPersistence(action.executionResult.metadata) as
                  | Record<string, unknown>
                  | undefined)
              }
            : undefined,
          payload: {
            patch: shouldRetainPatchBody
              ? action.payload.patch
              : `[[redacted patch body; original length=${action.payload.patch.length}]]`
          }
        };
      }

      if (action.type === "shell") {
        return {
          ...action,
          executionResult: action.executionResult
            ? {
                ...action.executionResult,
                message: redactSensitiveText(action.executionResult.message, 240),
                metadata: (sanitizeForPersistence(action.executionResult.metadata) as
                  | Record<string, unknown>
                  | undefined)
              }
            : undefined,
          payload: {
            ...action.payload,
            shell: redactSensitiveText(action.payload.shell, 240)
          }
        };
      }

      return action;
    })
  };
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
    value === "guardrail" ||
    value === "allowlist" ||
    value === "transport" ||
    value === "tool_not_found" ||
    value === "unknown"
  );
}

function normalizeToolErrorCategory(value: unknown): ToolErrorCategory | undefined {
  if (value === "allowlist") {
    return "guardrail";
  }
  return isToolErrorCategory(value) ? value : undefined;
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
      errorCategory: normalizeToolErrorCategory(record.errorCategory),
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
  const payload: WorkflowCheckpointPayload = {
    plan: sanitizePlanForCheckpoint(plan),
    toolTrace: sanitizeToolTraceForCheckpoint(toolTrace)
  };
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
