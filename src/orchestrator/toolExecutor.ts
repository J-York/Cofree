/**
 * Tool-call execution dispatcher.
 *
 * `executeToolCall` validates the workspace + JSON-parses the call
 * arguments once, then routes to a per-tool handler from `toolHandlers.ts`
 * based on `call.function.name`. The outer try/catch classifies any
 * thrown error via `classifyToolError` so every caller sees a structured
 * `ToolExecutionResult` instead of a raw exception.
 *
 * `executeToolCallWithRetry` wraps the dispatcher with an exponential-
 * backoff retry policy (see `shouldRetryToolCall`) and enriches the final
 * failure payload with an LLM-facing recovery hint.
 */
import {
  DEFAULT_TOOL_PERMISSIONS,
  type AppSettings,
  type ToolPermissions,
} from "../lib/settingsStore";
import type { AskUserRequest } from "./askUserService";
import type { ActionProposal, PlanStep } from "./types";
import type { ToolCallRecord } from "./llmToolLoop";
import type { CofreeRcConfig } from "../lib/cofreerc";
import type { WorkingMemory } from "./workingMemory";
import type {
  ToolErrorCategory,
  ToolExecutionStatus,
  ToolExecutionTrace,
} from "./toolTraceTypes";
import {
  buildToolErrorRecoveryHint,
  classifyToolError,
  computeToolRetryDelay,
  shouldRetryToolCall,
} from "./toolErrorClassification";
import { type SensitiveWriteAutoExecutionPolicy } from "./toolApprovalResolver";
import { TOOL_HANDLERS } from "./toolHandlers";

const MAX_TOOL_RESULT_PREVIEW = 400;
const MAX_TOOL_RETRY = 2;

const ALL_TOOL_NAMES = [
  "list_files",
  "read_file",
  "grep",
  "glob",
  "git_status",
  "git_diff",
  "propose_file_edit",
  "propose_shell",
  "check_shell_job",
  "diagnostics",
  "fetch",
  "ask_user",
] as const;


export interface ToolExecutionResult {
  content: string;
  /** @deprecated Use proposedActions[] instead. Kept for backward compat during transition. */
  proposedAction?: ActionProposal;
  /** P1-1: Array of proposed actions from sub-agent/team execution. */
  proposedActions?: ActionProposal[];
  errorCategory?: ToolErrorCategory;
  errorMessage?: string;
  success?: boolean;
  /** P1-3: Completion status, richer than boolean success. */
  completionStatus?: "completed" | "partial" | "failed";
  traceStatus?: ToolExecutionStatus;
  fromCache?: boolean;
}

export type { SensitiveWriteAutoExecutionPolicy } from "./toolApprovalResolver";

export interface TodoPlanStateLike {
  steps: PlanStep[];
  activeStepId?: string;
}

export interface ToolExecutorDeps {
  createActionId: (prefix: string) => string;
  nowIso: () => string;
  actionFingerprint: (action: ActionProposal) => string;
  smartTruncate: (content: string, maxLength: number) => string;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function resultPreview(content: string): string {
  return content.slice(0, MAX_TOOL_RESULT_PREVIEW);
}

export async function executeToolCall(
  call: ToolCallRecord,
  workspacePath: string,
  deps: ToolExecutorDeps,
  toolPermissions: ToolPermissions = DEFAULT_TOOL_PERMISSIONS,
  settings?: AppSettings,
  projectConfig?: CofreeRcConfig,
  enabledToolNames?: string[],
  planState?: TodoPlanStateLike,
  workingMemory?: WorkingMemory,
  signal?: AbortSignal,
  turn?: number,
  _focusedPaths?: string[],
  sessionId?: string,
  onAskUserRequest?: (request: AskUserRequest) => void,
  autoExecutionPolicy: SensitiveWriteAutoExecutionPolicy = "allow",
): Promise<ToolExecutionResult> {
  const safeWorkspace = workspacePath.trim();
  if (!safeWorkspace) {
    const message = "未选择工作区。";
    return {
      content: JSON.stringify({ error: message }),
      success: false,
      errorCategory: "workspace",
      errorMessage: message,
    };
  }

  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  } catch (_error) {
    const message = "tool arguments 不是合法 JSON";
    return {
      content: JSON.stringify({ error: message }),
      success: false,
      errorCategory: "validation",
      errorMessage: message,
    };
  }

  const handler = TOOL_HANDLERS[call.function.name];
  if (!handler) {
    return {
      content: JSON.stringify({
        error: `"${call.function.name}" is not a valid tool, try one of [${(enabledToolNames ?? ALL_TOOL_NAMES).join(", ")}].`,
      }),
      success: false,
      errorCategory: "tool_not_found",
      errorMessage: `未知工具: ${call.function.name}`,
    };
  }

  try {
    return await handler({
      call,
      args,
      safeWorkspace,
      deps,
      toolPermissions,
      settings,
      projectConfig,
      planState,
      workingMemory,
      signal,
      turn,
      sessionId,
      onAskUserRequest,
      autoExecutionPolicy,
    });
  } catch (error) {
    const message = String(error || "Unknown error");
    return {
      content: JSON.stringify({ error: message }),
      success: false,
      errorCategory: classifyToolError(message),
      errorMessage: message,
    };
  }
}

export async function executeToolCallWithRetry(
  call: ToolCallRecord,
  workspacePath: string,
  deps: ToolExecutorDeps,
  toolPermissions: ToolPermissions = DEFAULT_TOOL_PERMISSIONS,
  settings?: AppSettings,
  projectConfig?: CofreeRcConfig,
  enabledToolNames?: string[],
  planState?: TodoPlanStateLike,
  workingMemory?: WorkingMemory,
  signal?: AbortSignal,
  turn?: number,
  focusedPaths?: string[],
  sessionId?: string,
  onAskUserRequest?: (request: AskUserRequest) => void,
  autoExecutionPolicy: SensitiveWriteAutoExecutionPolicy = "allow",
): Promise<{
  result: ToolExecutionResult;
  trace: ToolExecutionTrace;
}> {
  const startedAt = deps.nowIso();
  let attempts = 0;
  let lastResult: ToolExecutionResult = {
    content: JSON.stringify({ error: "工具调用未执行" }),
    success: false,
    errorCategory: "unknown",
    errorMessage: "工具调用未执行",
  };

  while (attempts < MAX_TOOL_RETRY) {
    attempts += 1;

    // Apply exponential backoff delay between retry attempts
    if (attempts > 1) {
      const retryDelay = computeToolRetryDelay(attempts);
      console.log(
        `[ToolRetry] 工具 "${call.function.name}" 第 ${attempts} 次重试，延迟 ${Math.round(retryDelay)}ms`
      );
      await sleep(retryDelay, signal);
    }

    const current = await executeToolCall(
      call,
      workspacePath,
      deps,
      toolPermissions,
      settings,
      projectConfig,
      enabledToolNames,
      planState,
      workingMemory,
      signal,
      turn,
      focusedPaths,
      sessionId,
      onAskUserRequest,
      autoExecutionPolicy,
    );
    const success = current.success !== false;
    const traceStatus: ToolExecutionStatus = success
      ? current.traceStatus ?? "success"
      : "failed";
    const errorCategory =
      current.errorCategory ?? (success ? undefined : "unknown");
    const errorMessage =
      current.errorMessage ?? (success ? undefined : "工具调用失败");
    lastResult = {
      ...current,
      success,
      errorCategory,
      errorMessage,
      traceStatus,
    };

    if (success) {
      return {
        result: lastResult,
        trace: {
          callId: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
          startedAt,
          finishedAt: deps.nowIso(),
          attempts,
          status: traceStatus,
          retried: attempts > 1,
          resultPreview: resultPreview(current.content),
        },
      };
    }

    if (!shouldRetryToolCall(errorCategory ?? "unknown")) {
      break;
    }
  }

  // Append contextual error recovery hint to help the LLM self-correct
  const recoveryHint = buildToolErrorRecoveryHint(
    call.function.name,
    lastResult.errorCategory ?? "unknown",
    lastResult.errorMessage ?? "未知错误",
  );
  const enrichedContent = (() => {
    try {
      const parsed = JSON.parse(lastResult.content);
      parsed._recovery_hint = recoveryHint;
      return JSON.stringify(parsed);
    } catch {
      return JSON.stringify({
        error: lastResult.errorMessage ?? "工具调用失败",
        _recovery_hint: recoveryHint,
      });
    }
  })();

  return {
    result: {
      ...lastResult,
      content: enrichedContent,
    },
    trace: {
      callId: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      startedAt,
      finishedAt: deps.nowIso(),
      attempts,
      status: "failed",
      retried: attempts > 1,
      errorCategory: lastResult.errorCategory,
      errorMessage: lastResult.errorMessage,
      resultPreview: resultPreview(enrichedContent),
    },
  };
}
