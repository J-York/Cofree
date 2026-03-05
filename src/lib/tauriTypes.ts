/**
 * 与 Rust 后端 DTO 一一对应的 TypeScript 类型。
 * 所有 Tauri invoke 调用统一使用此文件中的类型。
 */

// ── 通用 / 工作区 ────────────────────────────────────────────────────────────

export interface AppHealth {
  status: string;
  milestone: string;
}

export interface WorkspaceInfo {
  path: string;
  git_branch: string | null;
  repo_name: string | null;
}

export interface FileEntry {
  name: string;
  is_dir: boolean;
  size: number;
  modified: number;
}

export interface ReadFileResult {
  content: string;
  total_lines: number;
  start_line: number;
  end_line: number;
}

// ── Git ──────────────────────────────────────────────────────────────────────

export interface GitStatus {
  modified: string[];
  added: string[];
  deleted: string[];
  untracked: string[];
}

// ── Patch / Snapshot ─────────────────────────────────────────────────────────

export interface PatchApplyResult {
  success: boolean;
  message: string;
  files: string[];
}

export interface SnapshotResult {
  success: boolean;
  snapshot_id: string;
  files: string[];
}

// ── Shell ────────────────────────────────────────────────────────────────────

export interface CommandExecutionResult {
  success: boolean;
  command: string;
  timed_out: boolean;
  status: number;
  stdout: string;
  stderr: string;
}

// ── Grep / Glob ──────────────────────────────────────────────────────────────

export interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
}

export interface GlobEntry {
  path: string;
  size: number;
  modified: number;
}

// ── Checkpoint ───────────────────────────────────────────────────────────────

export interface CheckpointRecord {
  checkpoint_id: string;
  session_id: string;
  message_id: string;
  workflow_state: string;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

export interface RecoveryResult {
  found: boolean;
  checkpoint: CheckpointRecord | null;
}

// ── LiteLLM ──────────────────────────────────────────────────────────────────

export interface LiteLLMHttpResponse {
  status: number;
  body: string;
  endpoint: string;
}

export interface StreamChunkEvent {
  request_id: string;
  content: string;
  done: boolean;
  finish_reason: string | null;
}

export interface ProxySettings {
  mode: string;
  url: string;
  username?: string;
  password?: string;
  no_proxy?: string;
}

// ── Diagnostics ──────────────────────────────────────────────────────────────

export interface DiagnosticEntry {
  file: string;
  line: number;
  column: number;
  severity: string;
  message: string;
}

export interface DiagnosticsResult {
  success: boolean;
  diagnostics: DiagnosticEntry[];
  tool_used: string;
  raw_output: string;
}

// ── Fetch ────────────────────────────────────────────────────────────────────

export interface FetchResult {
  success: boolean;
  url: string;
  content_type: string | null;
  content: string;
  truncated: boolean;
  error: string | null;
}
