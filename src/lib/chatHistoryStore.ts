/**
 * Cofree - AI Programming Cafe
 * File: src/lib/chatHistoryStore.ts
 * Milestone: 2
 * Task: 2.6
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Local persistence helpers for multi-turn chat history.
 */

import type { OrchestrationPlan } from "../orchestrator/types";
import { normalizeOrchestrationPlan } from "../orchestrator/planGuards";
import type { ToolErrorCategory, ToolExecutionTrace } from "../orchestrator/planningService";

export const CHAT_HISTORY_STORAGE_KEY = "cofree.chat.history.v1";

export interface ChatMessageRecord {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  plan: OrchestrationPlan | null;
  toolTrace?: ToolExecutionTrace[];
}

function normalizeRole(value: unknown): ChatMessageRecord["role"] | null {
  if (value === "user" || value === "assistant") {
    return value;
  }

  return null;
}

function normalizePlan(value: unknown): OrchestrationPlan | null {
  return normalizeOrchestrationPlan(value);
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

export function loadChatHistory(): ChatMessageRecord[] {
  if (typeof window === "undefined") {
    return [];
  }

  const raw = window.localStorage.getItem(CHAT_HISTORY_STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    const records: ChatMessageRecord[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const record = item as Record<string, unknown>;
      const role = normalizeRole(record.role);
      const content = typeof record.content === "string" ? record.content : "";
      const id = typeof record.id === "string" ? record.id : "";
      const createdAt = typeof record.createdAt === "string" ? record.createdAt : "";

      if (!role || !content.trim() || !id || !createdAt) {
        continue;
      }

      records.push({
        id,
        role,
        content,
        createdAt,
        plan: normalizePlan(record.plan),
        toolTrace: normalizeToolTrace(record.toolTrace)
      });
    }

    return records.slice(-80);
  } catch (_error) {
    return [];
  }
}

export function saveChatHistory(messages: ChatMessageRecord[]): void {
  if (typeof window === "undefined") {
    return;
  }

  const trimmedMessages = messages.slice(-80);
  window.localStorage.setItem(CHAT_HISTORY_STORAGE_KEY, JSON.stringify(trimmedMessages));
}

export function clearChatHistory(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(CHAT_HISTORY_STORAGE_KEY);
}
