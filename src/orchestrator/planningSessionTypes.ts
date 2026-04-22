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
  workingMemorySnapshot?: WorkingMemorySnapshot;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
  };
}
