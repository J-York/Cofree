import type { LiteLLMMessage } from "../lib/piAiBridge";
import type { AppSettings } from "../lib/settingsStore";
import type { ConversationAgentBinding } from "../agents/types";
import type { ChatContextAttachment } from "../lib/contextAttachments";
import type { AskUserRequest } from "./askUserService";
import type { ActionProposal, OrchestrationPlan } from "./types";
import type { TodoPlanState } from "./todoPlanState";
import type { ToolExecutionTrace, ToolExecutionStatus } from "./toolTraceTypes";
import type { WorkingMemorySnapshot } from "./workingMemory";

export type PlanningSessionPhase = "default";

export interface ToolCallEvent {
  type: "start" | "end";
  callId: string;
  toolName: string;
  argsPreview?: string;
  result?: ToolExecutionStatus;
  resultPreview?: string;
}

export interface RunPlanningSessionInput {
  prompt: string;
  settings: AppSettings;
  agentId?: string | ConversationAgentBinding;
  phase?: PlanningSessionPhase;
  conversationHistory?: Array<{
    role: "user" | "assistant" | "tool";
    content: string;
    tool_calls?: any[];
    tool_call_id?: string;
    name?: string;
  }>;
  contextAttachments?: ChatContextAttachment[];
  isContinuation?: boolean;
  internalSystemNote?: string;
  existingPlan?: OrchestrationPlan | null;
  blockedActionFingerprints?: string[];
  signal?: AbortSignal;
  onAssistantChunk?: (chunk: string) => void;
  onThinkingChunk?: (delta: string) => void;
  onToolCallEvent?: (event: ToolCallEvent) => void;
  onContextUpdate?: (estimatedTokens: number) => void;
  onLoopCheckpoint?: (checkpoint: {
    turn: number;
    proposedActions: ActionProposal[];
    planState: TodoPlanState;
    toolTrace: ToolExecutionTrace[];
    assistantReply: string;
    workingMemorySnapshot?: WorkingMemorySnapshot;
  }) => void;
  onPlanStateUpdate?: (
    planState: TodoPlanState,
    proposedActions: ActionProposal[]
  ) => void;
  sessionId?: string;
  onAskUserRequest?: (request: AskUserRequest) => void;
  restoredWorkingMemory?: WorkingMemorySnapshot;
  explicitSkillIds?: string[];
}

export interface PlanningSessionResult {
  assistantReply: string;
  plan: OrchestrationPlan;
  toolTrace: ToolExecutionTrace[];
  assistantToolCalls?: LiteLLMMessage["tool_calls"];
  /**
   * Intermediate (assistant tool_call → tool result) message pairs produced
   * during the loop, ordered, EXCLUDING the final assistant message (which is
   * captured via `assistantReply` + `assistantToolCalls`).
   *
   * The UI splices these as ChatMessageRecord entries before the placeholder
   * assistant so that subsequent turns can replay the full tool-use history
   * back to the model. Without this field, multi-step tool runs collapse into
   * a single assistant text bubble and the model loses everything it learned
   * along the way.
   */
  loopMessages: LiteLLMMessage[];
  workingMemorySnapshot?: WorkingMemorySnapshot;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
  };
}
