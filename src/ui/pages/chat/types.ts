import type { ChatMessageRecord } from "../../../lib/chatHistoryStore";
import type { CategorizedError } from "../../../lib/errorClassifier";
import type { ShellExecutionMode } from "../../../lib/shellCommand";
import type { ManualApprovalContext } from "../../../orchestrator/hitlService";
import type { ToolExecutionStatus } from "../../../orchestrator/toolTraceTypes";
import type { SubAgentProgressEvent } from "../../../orchestrator/types";

export interface LiveToolCall {
  callId: string;
  toolName: string;
  argsPreview?: string;
  status: "running" | ToolExecutionStatus;
  resultPreview?: string;
}

export interface SubAgentStatusItem {
  id: string;
  label: string;
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

export interface RunningShellJobMeta {
  messageId: string;
  actionId: string;
  workspacePath: string;
  executionMode: ShellExecutionMode;
  readyUrl?: string;
  readyTimeoutMs?: number;
  approvalContext?: ManualApprovalContext;
  detached?: boolean;
}

export interface ShellOutputBuffer {
  command: string;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  timerId: ReturnType<typeof setTimeout> | null;
}

export interface WorkspaceTeamTrustPromptState {
  key: string;
  messageId: string;
  teamActionIds: string[];
}
