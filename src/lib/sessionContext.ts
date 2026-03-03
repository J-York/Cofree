/**
 * Cofree - AI Programming Cafe
 * File: src/lib/sessionContext.ts
 * Milestone: 4
 * Task: 4.4
 * Description: React Context for cross-page session state sharing.
 */

import { createContext, useContext } from "react";
import type { ToolExecutionTrace } from "../orchestrator/planningService";

export type WorkflowPhase =
  | "idle"
  | "planning"
  | "executing"
  | "human_review"
  | "done"
  | "error";

export interface LLMRequestSummary {
  requestId: string;
  model: string;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface SessionState {
  currentPlan: string | null;
  toolTraces: ToolExecutionTrace[];
  requestSummaries: LLMRequestSummary[];
  workflowPhase: WorkflowPhase;
  lastError: string | null;
}

export interface SessionActions {
  updatePlan: (plan: string | null) => void;
  appendToolTraces: (traces: ToolExecutionTrace[]) => void;
  appendRequestSummary: (summary: LLMRequestSummary) => void;
  setWorkflowPhase: (phase: WorkflowPhase) => void;
  resetSession: () => void;
}

export const initialSessionState: SessionState = {
  currentPlan: null,
  toolTraces: [],
  requestSummaries: [],
  workflowPhase: "idle",
  lastError: null,
};

export const SessionContext = createContext<{
  state: SessionState;
  actions: SessionActions;
}>({
  state: initialSessionState,
  actions: {
    updatePlan: () => {},
    appendToolTraces: () => {},
    appendRequestSummary: () => {},
    setWorkflowPhase: () => {},
    resetSession: () => {},
  },
});

export function useSession() {
  return useContext(SessionContext);
}
