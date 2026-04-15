/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/hitlContinuationController.ts
 * Description: Orchestrator-facing controller that persists and advances HITL continuation state.
 */

import type { OrchestrationPlan } from "./types";
import {
  decideHitlContinuation,
  DEFAULT_HITL_CONTINUATION_MEMORY,
  normalizeHitlContinuationMemory,
  type HitlContinuationDecision,
  type HitlContinuationMemory
} from "./hitlContinuationMachine";
import { saveWorkflowCheckpoint } from "./checkpointStore";
import type { ToolExecutionTrace } from "./toolTraceTypes";
import type { WorkingMemorySnapshot } from "./workingMemory";

const memoryBySession = new Map<string, HitlContinuationMemory>();

function normalizeSessionKey(sessionId: string): string | null {
  const normalized = sessionId.trim();
  return normalized || null;
}

export function getHitlContinuationMemory(sessionId: string): HitlContinuationMemory {
  const normalized = normalizeSessionKey(sessionId);
  if (!normalized) {
    return DEFAULT_HITL_CONTINUATION_MEMORY;
  }
  return memoryBySession.get(normalized) ?? DEFAULT_HITL_CONTINUATION_MEMORY;
}

export function hydrateHitlContinuationMemory(sessionId: string, value: unknown): void {
  const normalized = normalizeSessionKey(sessionId);
  if (!normalized) return;
  memoryBySession.set(normalized, normalizeHitlContinuationMemory(value));
}

export function resetHitlContinuationMemory(sessionId: string): void {
  const normalized = normalizeSessionKey(sessionId);
  if (!normalized) return;
  memoryBySession.set(normalized, DEFAULT_HITL_CONTINUATION_MEMORY);
}

export async function advanceAfterHitl(params: {
  sessionId: string;
  messageId: string;
  plan: OrchestrationPlan;
  toolTrace?: ToolExecutionTrace[];
  maxRoundsPerPrompt?: number;
  workingMemorySnapshot?: WorkingMemorySnapshot;
}): Promise<HitlContinuationDecision> {
  const normalizedSessionId = normalizeSessionKey(params.sessionId);
  const sessionId = normalizedSessionId ?? params.sessionId.trim();
  const messageId = params.messageId.trim();
  const memory = normalizedSessionId
    ? memoryBySession.get(normalizedSessionId) ?? DEFAULT_HITL_CONTINUATION_MEMORY
    : DEFAULT_HITL_CONTINUATION_MEMORY;
  const decision = decideHitlContinuation({
    plan: params.plan,
    memory,
    maxRoundsPerPrompt: params.maxRoundsPerPrompt
  });

  if (normalizedSessionId) {
    memoryBySession.set(normalizedSessionId, decision.memory);
  }

  // Persist the latest decision memory along with plan/tool trace so reloads can continue safely.
  try {
    await saveWorkflowCheckpoint(
      sessionId,
      messageId,
      params.plan,
      params.toolTrace ?? [],
      decision.memory,
      params.workingMemorySnapshot,
    );
  } catch (error) {
    console.warn(
      "[HITL] Failed to persist continuation checkpoint",
      error,
    );
  }

  return decision;
}
