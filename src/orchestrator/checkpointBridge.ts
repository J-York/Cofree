import type { LiteLLMMessage } from "../lib/piAiBridge";
import {
  createWorkingMemory,
  restoreWorkingMemory,
  type WorkingMemory,
  type WorkingMemorySnapshot,
} from "./workingMemory";
import { clonePlanState, type TodoPlanState } from "./todoPlanState";
import type { ActionProposal } from "./types";
import type { ToolExecutionTrace } from "./toolTraceTypes";

/** Emit a partial-progress checkpoint every N tool-loop turns. */
export const INCREMENTAL_CHECKPOINT_INTERVAL = 10;

export type LoopCheckpoint = {
  turn: number;
  proposedActions: ActionProposal[];
  planState: TodoPlanState;
  toolTrace: ToolExecutionTrace[];
  assistantReply: string;
  /** P3-1: Working memory snapshot for checkpoint persistence. */
  workingMemorySnapshot?: WorkingMemorySnapshot;
};

export type LoopCheckpointCallback = (checkpoint: LoopCheckpoint) => void;

/**
 * Resolve the initial WorkingMemory for a tool loop: restore from a prior
 * checkpoint snapshot when present, otherwise allocate a fresh one sized
 * against the effective context budget.
 */
export function initWorkingMemoryForLoop(params: {
  restoredSnapshot: WorkingMemorySnapshot | undefined;
  limitTokens: number;
  outputReserveRatio: number;
  softBudgetRatio: number;
  internalSystemNote: string | undefined;
}): WorkingMemory {
  const {
    restoredSnapshot,
    limitTokens,
    outputReserveRatio,
    softBudgetRatio,
    internalSystemNote,
  } = params;
  if (restoredSnapshot) {
    const wm = restoreWorkingMemory(restoredSnapshot);
    console.log(
      `[Loop] Working memory restored from checkpoint | files=${wm.fileKnowledge.size}`
    );
    return wm;
  }
  const outputReserve = Math.min(
    8000,
    Math.max(512, Math.floor(limitTokens * outputReserveRatio))
  );
  const maxTokenBudget = Math.floor(
    Math.max(0, limitTokens - outputReserve) * softBudgetRatio * 0.2
  );
  return createWorkingMemory({
    maxTokenBudget,
    projectContext: internalSystemNote?.slice(0, 500) ?? "",
  });
}

/**
 * Emit an incremental checkpoint when the turn cadence fires and a callback
 * is registered. Never throws — checkpoint persistence must not derail the
 * loop.
 */
export function maybeEmitIncrementalCheckpoint(params: {
  turn: number;
  messages: LiteLLMMessage[];
  proposedActions: ActionProposal[];
  planState: TodoPlanState;
  toolTrace: ToolExecutionTrace[];
  snapshot: () => WorkingMemorySnapshot | undefined;
  onLoopCheckpoint: LoopCheckpointCallback | undefined;
}): void {
  const {
    turn,
    messages,
    proposedActions,
    planState,
    toolTrace,
    snapshot,
    onLoopCheckpoint,
  } = params;
  if (
    turn <= 0 ||
    turn % INCREMENTAL_CHECKPOINT_INTERVAL !== 0 ||
    !onLoopCheckpoint
  ) {
    return;
  }
  try {
    const assistantMsgs = messages.filter((m) => m.role === "assistant");
    const lastReply =
      assistantMsgs.length > 0
        ? assistantMsgs[assistantMsgs.length - 1].content
        : "";
    onLoopCheckpoint({
      turn,
      proposedActions: [...proposedActions],
      planState: clonePlanState(planState),
      toolTrace: [...toolTrace],
      assistantReply: lastReply,
      workingMemorySnapshot: snapshot(),
    });
    console.log(
      `[Loop] 增量检查点已保存 | turn=${turn} | actions=${proposedActions.length} | traces=${toolTrace.length}`
    );
  } catch (checkpointError) {
    console.warn(`[Loop] 增量检查点保存失败:`, checkpointError);
  }
}
