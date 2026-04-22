import type { ChatMessageRecord } from "../../../lib/chatHistoryStore";
import type { CategorizedError } from "../../../lib/errorClassifier";
import type { ShellExecutionMode } from "../../../lib/shellCommand";
import type { ManualApprovalContext } from "../../../orchestrator/hitlService";
import type { ToolExecutionStatus } from "../../../orchestrator/toolTraceTypes";
export interface LiveToolCall {
  callId: string;
  toolName: string;
  argsPreview?: string;
  status: "running" | ToolExecutionStatus;
  resultPreview?: string;
}


export interface BackgroundStreamState {
  messages: ChatMessageRecord[];
  isStreaming: boolean;
  tokenCount: number | null;
  sessionNote: string;
  liveToolCalls: LiveToolCall[];
  error: CategorizedError | null;
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