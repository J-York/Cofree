/**
 * 类型安全的 Tauri invoke 桥接层。
 * 所有前端 → 后端调用统一通过本模块，便于测试 mock 和类型检查。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AppHealth,
  CheckpointRecord,
  CommandExecutionResult,
  DiagnosticsResult,
  FetchResult,
  FileEntry,
  GlobEntry,
  GrepResult,
  HttpResponsePayload,

  PatchApplyResult,
  ProxySettings,
  ReadFileResult,
  RecoveryResult,
  ShellCommandEvent,
  ShellCommandStartResult,
  SnapshotResult,
  WorkspaceInfo,
} from "./tauriTypes";

// ── 通用 / 工作区 ────────────────────────────────────────────────────────────

export function healthcheck(): Promise<AppHealth> {
  return invoke<AppHealth>("healthcheck");
}

export function selectWorkspaceFolder(): Promise<string | null> {
  return invoke<string | null>("select_workspace_folder");
}

export function validateGitRepo(path: string): Promise<boolean> {
  return invoke<boolean>("validate_git_repo", { path });
}

export function getWorkspaceInfo(path: string): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("get_workspace_info", { path });
}

// ── 文件操作 ─────────────────────────────────────────────────────────────────

export function readWorkspaceFile(params: {
  workspacePath: string;
  relativePath: string;
  startLine?: number;
  endLine?: number;
  ignorePatterns?: string[];
}): Promise<ReadFileResult> {
  return invoke<ReadFileResult>("read_workspace_file", {
    workspacePath: params.workspacePath,
    relativePath: params.relativePath,
    startLine: params.startLine,
    endLine: params.endLine,
    ignorePatterns: params.ignorePatterns,
  });
}

export function listWorkspaceFiles(params: {
  workspacePath: string;
  relativePath: string;
  ignorePatterns?: string[];
}): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("list_workspace_files", {
    workspacePath: params.workspacePath,
    relativePath: params.relativePath,
    ignorePatterns: params.ignorePatterns,
  });
}

// ── Git ──────────────────────────────────────────────────────────────────────

export function gitStatusWorkspace(workspacePath: string) {
  return invoke<{
    modified: string[];
    added: string[];
    deleted: string[];
    untracked: string[];
  }>("git_status_workspace", { workspacePath });
}

export function gitDiffWorkspace(
  workspacePath: string,
  filePath?: string,
): Promise<string> {
  return invoke<string>("git_diff_workspace", { workspacePath, filePath });
}

// ── Grep / Glob ──────────────────────────────────────────────────────────────

export function grepWorkspaceFiles(params: {
  workspacePath: string;
  pattern: string;
  includeGlob?: string;
  maxResults?: number;
  ignorePatterns?: string[];
}): Promise<GrepResult> {
  return invoke<GrepResult>("grep_workspace_files", {
    workspacePath: params.workspacePath,
    pattern: params.pattern,
    includeGlob: params.includeGlob,
    maxResults: params.maxResults,
    ignorePatterns: params.ignorePatterns,
  });
}

export function globWorkspaceFiles(params: {
  workspacePath: string;
  pattern: string;
  maxResults?: number;
  ignorePatterns?: string[];
}): Promise<GlobEntry[]> {
  return invoke<GlobEntry[]>("glob_workspace_files", {
    workspacePath: params.workspacePath,
    pattern: params.pattern,
    maxResults: params.maxResults,
    ignorePatterns: params.ignorePatterns,
  });
}

// ── Patch / Snapshot ─────────────────────────────────────────────────────────

export function checkWorkspacePatch(
  workspacePath: string,
  patch: string,
): Promise<PatchApplyResult> {
  return invoke<PatchApplyResult>("check_workspace_patch", {
    workspacePath,
    patch,
  });
}

export function applyWorkspacePatch(
  workspacePath: string,
  patch: string,
): Promise<PatchApplyResult> {
  return invoke<PatchApplyResult>("apply_workspace_patch", {
    workspacePath,
    patch,
  });
}

export function createWorkspaceSnapshot(
  workspacePath: string,
  patch?: string,
): Promise<SnapshotResult> {
  return invoke<SnapshotResult>("create_workspace_snapshot", {
    workspacePath,
    patch,
  });
}

export function restoreWorkspaceSnapshot(
  workspacePath: string,
  snapshotId?: string,
): Promise<PatchApplyResult> {
  return invoke<PatchApplyResult>("restore_workspace_snapshot", {
    workspacePath,
    snapshotId,
  });
}

// ── Shell ────────────────────────────────────────────────────────────────────

export function runShellCommand(params: {
  workspacePath: string;
  shell: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<CommandExecutionResult> {
  return invoke<CommandExecutionResult>("run_shell_command", {
    workspacePath: params.workspacePath,
    shell: params.shell,
    timeoutMs: params.timeoutMs,
    maxOutputBytes: params.maxOutputBytes,
  });
}

export function startShellCommand(params: {
  workspacePath: string;
  shell: string;
  timeoutMs?: number;
  detached?: boolean;
  maxOutputBytes?: number;
}): Promise<ShellCommandStartResult> {
  return invoke<ShellCommandStartResult>("start_shell_command", {
    workspacePath: params.workspacePath,
    shell: params.shell,
    timeoutMs: params.timeoutMs,
    detached: params.detached,
    maxOutputBytes: params.maxOutputBytes,
  });
}

export function cancelShellCommand(jobId: string): Promise<boolean> {
  return invoke<boolean>("cancel_shell_command", { jobId });
}

export function openSystemTerminal(workspacePath: string): Promise<void> {
  return invoke<void>("open_system_terminal", { workspacePath });
}

export function checkShellJob(jobId: string): Promise<{
  running: boolean;
  found: boolean;
  completed: boolean;
  cancelled?: boolean;
  /** Only present when completed === true */
  success?: boolean;
  exit_code?: number;
  timed_out?: boolean;
  stdout?: string;
  stderr?: string;
}> {
  return invoke("check_shell_job", { jobId });
}

/**
 * Non-blocking shell execution that returns a Promise resolving on completion.
 *
 * Uses `start_shell_command` + `shell-command-event` listener internally so the
 * JS event loop stays free while the command runs.  Supports `AbortSignal` for
 * cancellation and an optional streaming output callback.
 */
export async function awaitShellCommand(params: {
  workspacePath: string;
  shell: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}): Promise<CommandExecutionResult> {
  if (params.signal?.aborted) {
    throw new DOMException("Shell command aborted", "AbortError");
  }

  let resolveResult!: (result: CommandExecutionResult) => void;
  const resultPromise = new Promise<CommandExecutionResult>((resolve) => {
    resolveResult = resolve;
  });

  let jobId: string | null = null;
  let settled = false;
  let abortHandler: (() => void) | null = null;
  const bufferedEvents: ShellCommandEvent[] = [];

  const buildResult = (p: ShellCommandEvent): CommandExecutionResult => ({
    success: Boolean(p.success),
    command: p.command,
    timed_out: Boolean(p.timed_out),
    status: Number(p.status ?? -1),
    stdout: String(p.stdout ?? ""),
    stderr: String(p.stderr ?? ""),
    cancelled: Boolean(p.cancelled),
    stdout_truncated: Boolean(p.stdout_truncated),
    stderr_truncated: Boolean(p.stderr_truncated),
    stdout_total_bytes: Number(p.stdout_total_bytes ?? 0),
    stderr_total_bytes: Number(p.stderr_total_bytes ?? 0),
    output_limit_bytes: Number(p.output_limit_bytes ?? 0),
  });

  const handleEvent = (payload: ShellCommandEvent) => {
    if (settled) return;
    if (
      payload.event_type === "output" &&
      params.onOutput &&
      payload.chunk &&
      payload.stream
    ) {
      params.onOutput(payload.stream, payload.chunk);
    }
    if (payload.event_type === "completed") {
      settled = true;
      resolveResult(buildResult(payload));
    }
  };

  // Register listener BEFORE starting the command to avoid race conditions.
  const unlisten = await listen<ShellCommandEvent>(
    "shell-command-event",
    (event) => {
      const payload = event.payload;
      if (jobId === null) {
        bufferedEvents.push(payload);
        return;
      }
      if (payload.job_id !== jobId) return;
      handleEvent(payload);
    },
  );

  try {
    const started = await startShellCommand({
      workspacePath: params.workspacePath,
      shell: params.shell,
      timeoutMs: params.timeoutMs,
      detached: false,
      maxOutputBytes: params.maxOutputBytes,
    });
    jobId = started.job_id;

    // Drain any events that arrived between listener registration and now.
    for (const evt of bufferedEvents) {
      if (evt.job_id === jobId) handleEvent(evt);
    }
    bufferedEvents.length = 0;

    if (params.signal && !settled) {
      abortHandler = () => {
        if (jobId && !settled) cancelShellCommand(jobId).catch(() => {});
      };
      if (params.signal.aborted) {
        abortHandler();
      } else {
        params.signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    return await resultPromise;
  } finally {
    unlisten();
    if (abortHandler && params.signal) {
      params.signal.removeEventListener("abort", abortHandler);
    }
  }
}

/**
 * Shell execution with a deadline (block_until_ms).
 *
 * Starts the command and waits up to `blockUntilMs` for it to complete.
 * If the deadline fires before completion, the command continues running
 * in the background and the function returns immediately with:
 *   - moved_to_background: true
 *   - job_id: the background job id (can be used to cancel/check later)
 *   - partial_stdout / partial_stderr: output collected so far
 *
 * This prevents foreground commands that never exit (e.g. `npm run dev`)
 * from blocking the Agent tool-calling loop indefinitely.
 */
export async function awaitShellCommandWithDeadline(params: {
  workspacePath: string;
  shell: string;
  blockUntilMs: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}): Promise<
  | { moved_to_background: false; result: CommandExecutionResult }
  | { moved_to_background: true; job_id: string; partial_stdout: string; partial_stderr: string }
> {
  if (params.signal?.aborted) {
    throw new DOMException("Shell command aborted", "AbortError");
  }

  let jobId: string | null = null;
  let settled = false;
  let abortHandler: (() => void) | null = null;
  const bufferedEvents: ShellCommandEvent[] = [];
  let partialStdout = "";
  let partialStderr = "";

  let resolveCompleted!: (result: CommandExecutionResult) => void;

  const completedPromise = new Promise<CommandExecutionResult>((resolve) => {
    resolveCompleted = resolve;
  });
  let deadlineTimer: ReturnType<typeof setTimeout>;
  const deadlinePromise = new Promise<"deadline">((resolve) => {
    deadlineTimer = setTimeout(() => resolve("deadline"), params.blockUntilMs);
  });
  // Suppress unhandled rejection if deadline fires first
  void deadlinePromise.catch(() => {});

  const buildResult = (p: ShellCommandEvent): CommandExecutionResult => ({
    success: Boolean(p.success),
    command: p.command,
    timed_out: Boolean(p.timed_out),
    status: Number(p.status ?? -1),
    stdout: String(p.stdout ?? ""),
    stderr: String(p.stderr ?? ""),
    cancelled: Boolean(p.cancelled),
    stdout_truncated: Boolean(p.stdout_truncated),
    stderr_truncated: Boolean(p.stderr_truncated),
    stdout_total_bytes: Number(p.stdout_total_bytes ?? 0),
    stderr_total_bytes: Number(p.stderr_total_bytes ?? 0),
    output_limit_bytes: Number(p.output_limit_bytes ?? 0),
  });

  const handleEvent = (payload: ShellCommandEvent) => {
    if (settled) return;
    if (payload.event_type === "output" && payload.chunk) {
      if (payload.stream === "stdout") {
        partialStdout += payload.chunk;
        // Trim to keep only the tail within the byte cap so the partial buffer
        // doesn't grow without bound for verbose commands (e.g. dev servers).
        if (params.maxOutputBytes && partialStdout.length > params.maxOutputBytes) {
          partialStdout = partialStdout.slice(-params.maxOutputBytes);
        }
      } else if (payload.stream === "stderr") {
        partialStderr += payload.chunk;
        if (params.maxOutputBytes && partialStderr.length > params.maxOutputBytes) {
          partialStderr = partialStderr.slice(-params.maxOutputBytes);
        }
      }
      if (params.onOutput && payload.stream) {
        params.onOutput(payload.stream, payload.chunk);
      }
    }
    if (payload.event_type === "completed") {
      settled = true;
      resolveCompleted(buildResult(payload));
    }
  };

  const unlisten = await listen<ShellCommandEvent>(
    "shell-command-event",
    (event) => {
      const payload = event.payload;
      if (jobId === null) {
        bufferedEvents.push(payload);
        return;
      }
      if (payload.job_id !== jobId) return;
      handleEvent(payload);
    },
  );

  try {
    const started = await startShellCommand({
      workspacePath: params.workspacePath,
      shell: params.shell,
      timeoutMs: params.timeoutMs,
      detached: false,
      maxOutputBytes: params.maxOutputBytes,
    });
    jobId = started.job_id;

    for (const evt of bufferedEvents) {
      if (evt.job_id === jobId) handleEvent(evt);
    }
    bufferedEvents.length = 0;

    if (params.signal && !settled) {
      abortHandler = () => {
        if (jobId && !settled) cancelShellCommand(jobId).catch(() => {});
      };
      if (params.signal.aborted) {
        abortHandler();
      } else {
        params.signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    const winner = await Promise.race([completedPromise, deadlinePromise]);

    if (winner === "deadline") {
      // Command is still running — leave it running, return partial output
      return {
        moved_to_background: true,
        job_id: jobId,
        partial_stdout: partialStdout,
        partial_stderr: partialStderr,
      };
    }

    // Command completed before deadline — clear the timer
    clearTimeout(deadlineTimer!);

    // Command completed before deadline
    return { moved_to_background: false, result: winner as CommandExecutionResult };
  } finally {
    // Only stop listening if the command completed; if moved to background we
    // must NOT unlisten — the ChatPage shell-command-event listener will continue
    // to receive output events for this job.
    if (settled) {
      unlisten();
    } else {
      // moved to background: unregister our local listener (ChatPage has its own)
      unlisten();
    }
    if (abortHandler && params.signal) {
      params.signal.removeEventListener("abort", abortHandler);
    }
  }
}

// ── Checkpoint ───────────────────────────────────────────────────────────────

export function saveWorkflowCheckpoint(params: {
  sessionId: string;
  messageId: string;
  workflowState: string;
  payloadJson: string;
}): Promise<CheckpointRecord> {
  return invoke<CheckpointRecord>("save_workflow_checkpoint", {
    sessionId: params.sessionId,
    messageId: params.messageId,
    workflowState: params.workflowState,
    payloadJson: params.payloadJson,
  });
}

export function loadLatestWorkflowCheckpoint(
  sessionId: string,
): Promise<RecoveryResult> {
  return invoke<RecoveryResult>("load_latest_workflow_checkpoint", {
    sessionId,
  });
}

export function deleteWorkflowCheckpoints(
  sessionPrefix: string,
): Promise<number> {
  return invoke<number>("delete_workflow_checkpoints", {
    sessionPrefix,
  });
}

// ── LiteLLM ──────────────────────────────────────────────────────────────────

export function fetchLitellmModels(params: {
  baseUrl: string;
  apiKey: string;
  protocol: "openai-chat-completions" | "openai-responses" | "anthropic-messages";
  proxy?: ProxySettings;
}): Promise<string[]> {
  return invoke<string[]>("fetch_litellm_models", {
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    protocol: params.protocol,
    proxy: params.proxy,
  });
}

// ── Secure API Key ───────────────────────────────────────────────────────────

export function loadSecureApiKey(
  secretSlot?: string,
): Promise<string> {
  return invoke<string>("load_secure_api_key", { profileId: secretSlot });
}

export function saveSecureApiKey(
  apiKey: string,
  secretSlot?: string,
): Promise<void> {
  return invoke<void>("save_secure_api_key", { profileId: secretSlot, apiKey });
}

export function deleteSecureApiKey(secretSlot: string): Promise<void> {
  return invoke<void>("delete_secure_api_key", { profileId: secretSlot });
}

// ── File Dialog ──────────────────────────────────────────────────────────────

export function saveFileDialog(
  fileName: string,
  content: string,
): Promise<string> {
  return invoke<string>("save_file_dialog", { fileName, content });
}

// ── Diagnostics ──────────────────────────────────────────────────────────────

export function getWorkspaceDiagnostics(params: {
  workspacePath: string;
  changedFiles?: string[];
}): Promise<DiagnosticsResult> {
  return invoke<DiagnosticsResult>("get_workspace_diagnostics", {
    workspacePath: params.workspacePath,
    changedFiles: params.changedFiles,
  });
}

// ── Fetch URL ────────────────────────────────────────────────────────────────

export function fetchUrl(params: {
  url: string;
  maxSize?: number;
  proxy?: ProxySettings;
}): Promise<FetchResult> {
  return invoke<FetchResult>("fetch_url", {
    url: params.url,
    maxSize: params.maxSize,
    proxy: params.proxy,
  });
}

export function performHttpRequest(params: {
  requestId?: string;
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body?: string | null;
  proxy?: ProxySettings;
}): Promise<HttpResponsePayload> {
  return invoke<HttpResponsePayload>("perform_http_request", {
    requestId: params.requestId,
    method: params.method,
    url: params.url,
    headers: params.headers,
    body: params.body,
    proxy: params.proxy,
  });
}

export function cancelHttpRequest(requestId: string): Promise<boolean> {
  return invoke<boolean>("cancel_http_request", { requestId });
}
