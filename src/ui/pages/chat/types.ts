import type { ChatMessageRecord } from "../../../lib/chatHistoryStore";
import type { CategorizedError } from "../../../lib/errorClassifier";
import type { ToolExecutionStatus } from "../../../orchestrator/planningService";
import type { SubAgentProgressEvent } from "../../../orchestrator/types";

export interface LiveToolCall {
  callId: string;
  toolName: string;
  argsPreview?: string;
  status: "running" | ToolExecutionStatus;
  resultPreview?: string;
}

export interface SubAgentStatusItem {
  role: string;
  lastEvent: SubAgentProgressEvent;
  updatedAt: number;
}

export interface BackgroundStreamState {
  messages: ChatMessageRecord[];
  isStreaming: boolean;
  tokenCount: number | null;
  sessionNote: string;
  liveToolCalls: LiveToolCall[];
  error: CategorizedError | null;
  subAgentStatus: SubAgentStatusItem[];
}
