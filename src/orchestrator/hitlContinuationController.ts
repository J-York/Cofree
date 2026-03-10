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
import type { ToolExecutionTrace } from "./planningService";

const memoryBySession = new Map<string, HitlContinuationMemory>();

export function getHitlContinuationMemory(sessionId: string): HitlContinuationMemory {
  const normalized = sessionId.trim();
  if (!normalized) {
    return DEFAULT_HITL_CONTINUATION_MEMORY;
  }
  return memoryBySession.get(normalized) ?? DEFAULT_HITL_CONTINUATION_MEMORY;
}

export function hydrateHitlContinuationMemory(sessionId: string, value: unknown): void {
  const normalized = sessionId.trim();
  if (!normalized) return;
  memoryBySession.set(normalized, normalizeHitlContinuationMemory(value));
}

export function resetHitlContinuationMemory(sessionId: string): void {
  const normalized = sessionId.trim();
  if (!normalized) return;
  memoryBySession.set(normalized, DEFAULT_HITL_CONTINUATION_MEMORY);
}

export async function advanceAfterHitl(params: {
  sessionId: string;
  messageId: string;
  plan: OrchestrationPlan;
  toolTrace?: ToolExecutionTrace[];
  maxRoundsPerPrompt?: number;
}): Promise<HitlContinuationDecision> {
  const sessionId = params.sessionId.trim();
  const messageId = params.messageId.trim();
  const memory = getHitlContinuationMemory(sessionId);
  const decision = decideHitlContinuation({
    plan: params.plan,
    memory,
    maxRoundsPerPrompt: params.maxRoundsPerPrompt
  });

  memoryBySession.set(sessionId, decision.memory);

  // Persist the latest decision memory along with plan/tool trace so reloads can continue safely.
  try {
    await saveWorkflowCheckpoint(
      sessionId,
      messageId,
      params.plan,
      params.toolTrace ?? [],
      decision.memory
    );
  } catch (error) {
    console.warn(
      "[HITL] Failed to persist continuation checkpoint",
      error,
    );
  }

  return decision;
}
