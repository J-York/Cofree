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
import type { ToolErrorCategory, ToolExecutionTrace } from "../orchestrator/toolTraceTypes";
import {
  normalizeContextAttachments,
  type ChatContextAttachment,
} from "./contextAttachments";

export const CHAT_HISTORY_STORAGE_KEY = "cofree.chat.history.v1";

/** Optional speaker line for assistant messages (expert-panel / multi-speaker timeline). */
export interface AssistantSpeaker {
  id: string;
  label: string;
}

export interface ChatMessageRecord {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
  plan: OrchestrationPlan | null;
  contextAttachments?: ChatContextAttachment[];
  toolTrace?: ToolExecutionTrace[];
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
  agentId?: string;
  assistantSpeaker?: AssistantSpeaker;
  /** Skill IDs explicitly selected by the user for this message. Persisted so
   * HITL continuation can re-inject the same skill context without depending
   * on transient UI state (selectedSkills). */
  explicitSkillIds?: string[];
  /** Snippet IDs explicitly selected by the user for this message. Same
   * persistence rationale as explicitSkillIds. */
  explicitSnippetIds?: string[];
}

function normalizeRole(value: unknown): ChatMessageRecord["role"] | null {
  if (value === "user" || value === "assistant" || value === "tool") {
    return value;
  }

  return null;
}

function normalizePlan(value: unknown): OrchestrationPlan | null {
  return normalizeOrchestrationPlan(value);
}

export function normalizeChatMessages(value: unknown): ChatMessageRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const records: ChatMessageRecord[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const role = normalizeRole(record.role);
    const content = typeof record.content === "string" ? record.content : "";
    const id = typeof record.id === "string" ? record.id : "";
    const createdAt = typeof record.createdAt === "string" ? record.createdAt : "";

    let tool_calls;
    if (Array.isArray(record.tool_calls)) {
      tool_calls = record.tool_calls.filter(tc => tc && typeof tc === "object" && typeof tc.id === "string");
    }

    const tool_call_id = typeof record.tool_call_id === "string" ? record.tool_call_id : undefined;
    const name = typeof record.name === "string" ? record.name : undefined;

    const hasValidContent = content.trim() || role === "tool" || (role === "assistant" && tool_calls && tool_calls.length > 0);

    if (!role || !id || !createdAt || !hasValidContent) {
      continue;
    }

    let assistantSpeaker: AssistantSpeaker | undefined;
    if (record.assistantSpeaker && typeof record.assistantSpeaker === "object") {
      const sp = record.assistantSpeaker as Record<string, unknown>;
      const sid = typeof sp.id === "string" ? sp.id : "";
      const slabel = typeof sp.label === "string" ? sp.label : "";
      if (sid && slabel) {
        assistantSpeaker = { id: sid, label: slabel };
      }
    }

    records.push({
      id,
      role,
      content,
      createdAt,
      plan: normalizePlan(record.plan),
      contextAttachments: normalizeContextAttachments(record.contextAttachments),
      toolTrace: normalizeToolTrace(record.toolTrace),
      tool_calls,
      tool_call_id,
      name,
      agentId: typeof record.agentId === "string" ? record.agentId : undefined,
      assistantSpeaker,
      explicitSkillIds: Array.isArray(record.explicitSkillIds) && record.explicitSkillIds.every((id: unknown) => typeof id === "string")
        ? record.explicitSkillIds as string[]
        : undefined,
      explicitSnippetIds: Array.isArray(record.explicitSnippetIds) && record.explicitSnippetIds.every((id: unknown) => typeof id === "string")
        ? record.explicitSnippetIds as string[]
        : undefined,
    });
  }

  return records.slice(-80);
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
      (record.status !== "success" &&
        record.status !== "failed" &&
        record.status !== "pending_approval") ||
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
    return normalizeChatMessages(parsed);
  } catch (_error) {
    return [];
  }
}

export function saveChatHistory(messages: ChatMessageRecord[]): void {
  if (typeof window === "undefined") {
    return;
  }

  const trimmedMessages = messages.slice(-80).map((message) => ({
    ...message,
    plan: null,
    contextAttachments: normalizeContextAttachments(message.contextAttachments),
    toolTrace: (message.toolTrace ?? []).slice(-20).map((trace) => ({
      callId: trace.callId,
      name: trace.name,
      arguments: trace.arguments.slice(0, 240),
      startedAt: trace.startedAt,
      finishedAt: trace.finishedAt,
      attempts: trace.attempts,
      status: trace.status,
      retried: trace.retried,
      errorCategory: trace.errorCategory,
      errorMessage: trace.errorMessage?.slice(0, 240),
      resultPreview: trace.resultPreview?.slice(0, 240)
    }))
  }));
  window.localStorage.setItem(CHAT_HISTORY_STORAGE_KEY, JSON.stringify(trimmedMessages));
}

/**
 * Return a new array containing every message BEFORE `fromMessageId`. The
 * target message itself and everything after it is dropped — used by the
 * "edit user message" flow to discard the old turn (and any assistant /
 * tool messages that followed) before replaying with new content.
 *
 * If the id is not found, returns the original array reference unchanged
 * so callers can detect the no-op without comparing arrays element-wise.
 */
export function truncateMessagesFrom(
  messages: ChatMessageRecord[],
  fromMessageId: string,
): ChatMessageRecord[] {
  const idx = messages.findIndex((m) => m.id === fromMessageId);
  if (idx < 0) return messages;
  return messages.slice(0, idx);
}

export function clearChatHistory(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(CHAT_HISTORY_STORAGE_KEY);
}
