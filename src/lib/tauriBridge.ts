/**
 * 类型安全的 Tauri invoke 桥接层。
 * 所有前端 → 后端调用统一通过本模块，便于测试 mock 和类型检查。
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  AppHealth,
  CheckpointRecord,
  CommandExecutionResult,
  DiagnosticsResult,
  FetchResult,
  FileEntry,
  GlobEntry,
  GrepResult,
  LiteLLMHttpResponse,
  PatchApplyResult,
  ProxySettings,
  ReadFileResult,
  RecoveryResult,
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
}): Promise<CommandExecutionResult> {
  return invoke<CommandExecutionResult>("run_shell_command", {
    workspacePath: params.workspacePath,
    shell: params.shell,
    timeoutMs: params.timeoutMs,
  });
}

export function startShellCommand(params: {
  workspacePath: string;
  shell: string;
  timeoutMs?: number;
  detached?: boolean;
}): Promise<ShellCommandStartResult> {
  return invoke<ShellCommandStartResult>("start_shell_command", {
    workspacePath: params.workspacePath,
    shell: params.shell,
    timeoutMs: params.timeoutMs,
    detached: params.detached,
  });
}

export function cancelShellCommand(jobId: string): Promise<boolean> {
  return invoke<boolean>("cancel_shell_command", { jobId });
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

export function postLitellmChatCompletions(params: {
  baseUrl: string;
  apiKey: string;
  protocol: "openai-chat-completions" | "openai-responses" | "anthropic-messages";
  body: unknown;
  proxy?: ProxySettings;
}): Promise<LiteLLMHttpResponse> {
  return invoke<LiteLLMHttpResponse>("post_litellm_chat_completions", {
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    protocol: params.protocol,
    body: params.body,
    proxy: params.proxy,
  });
}

export function postLitellmChatCompletionsStream(params: {
  baseUrl: string;
  apiKey: string;
  protocol?: string;
  body: unknown;
  requestId: string;
  proxy?: ProxySettings;
}): Promise<LiteLLMHttpResponse> {
  return invoke<LiteLLMHttpResponse>("post_litellm_chat_completions_stream", {
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    protocol: params.protocol,
    body: params.body,
    requestId: params.requestId,
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
