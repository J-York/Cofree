//! 与前端交互的 DTO，供 application 与 presentation 层使用。

use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize)]
pub struct AppHealth {
    pub status: String,
    pub milestone: String,
}

#[derive(Clone, Serialize)]
pub struct WorkspaceInfo {
    pub path: String,
    pub git_branch: Option<String>,
    pub repo_name: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
}

#[derive(Clone, Serialize)]
pub struct GitStatus {
    pub modified: Vec<String>,
    pub added: Vec<String>,
    pub deleted: Vec<String>,
    pub untracked: Vec<String>,
}

#[derive(Clone, Serialize)]
pub struct PatchApplyResult {
    pub success: bool,
    pub message: String,
    pub files: Vec<String>,
}

#[derive(Clone, Serialize)]
pub struct CommandExecutionResult {
    pub success: bool,
    pub command: String,
    pub timed_out: bool,
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub stdout_total_bytes: u64,
    pub stderr_total_bytes: u64,
    pub output_limit_bytes: Option<u64>,
}

#[derive(Clone, Serialize)]
pub struct ShellCommandStartResult {
    pub job_id: String,
    pub command: String,
}

#[derive(Clone, Serialize)]
pub struct ShellCommandEvent {
    pub job_id: String,
    pub event_type: String,
    pub command: String,
    pub stream: Option<String>,
    pub chunk: Option<String>,
    pub success: Option<bool>,
    pub timed_out: Option<bool>,
    pub cancelled: Option<bool>,
    pub status: Option<i32>,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
    pub stdout_truncated: Option<bool>,
    pub stderr_truncated: Option<bool>,
    pub stdout_total_bytes: Option<u64>,
    pub stderr_total_bytes: Option<u64>,
    pub output_limit_bytes: Option<u64>,
    /// Detected interactive prompt text (only set for waiting_for_input events)
    pub prompt_text: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct SnapshotResult {
    pub success: bool,
    pub snapshot_id: String,
    pub files: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SnapshotFileRecord {
    pub path: String,
    pub existed: bool,
    pub backup_path: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SnapshotManifest {
    pub files: Vec<SnapshotFileRecord>,
}

#[derive(Clone, Serialize)]
pub struct CheckpointRecord {
    pub checkpoint_id: String,
    pub session_id: String,
    pub message_id: String,
    pub workflow_state: String,
    pub payload_json: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Serialize)]
pub struct RecoveryResult {
    pub found: bool,
    pub checkpoint: Option<CheckpointRecord>,
}

#[derive(Clone, Serialize)]
pub struct GrepMatch {
    pub file: String,
    pub line: usize,
    pub content: String,
}

#[derive(Clone, Serialize)]
pub struct GrepResult {
    pub matches: Vec<GrepMatch>,
    pub truncated: bool,
}

#[derive(Clone, Serialize)]
pub struct GlobEntry {
    pub path: String,
    pub size: u64,
    pub modified: u64,
}

#[derive(Clone, Serialize)]
pub struct ReadFileResult {
    pub content: String,
    pub total_lines: usize,
    pub start_line: usize,
    pub end_line: usize,
}

#[derive(Clone, Serialize)]
pub struct DiagnosticEntry {
    pub file: String,
    pub line: usize,
    pub column: usize,
    pub severity: String,
    pub message: String,
}

#[derive(Clone, Serialize)]
pub struct DiagnosticsResult {
    pub success: bool,
    pub diagnostics: Vec<DiagnosticEntry>,
    pub tool_used: String,
    pub raw_output: String,
}

#[derive(Clone, Serialize)]
pub struct FetchResult {
    pub success: bool,
    pub url: String,
    pub content_type: Option<String>,
    pub content: String,
    pub truncated: bool,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct SymbolInfo {
    pub kind: String,
    pub name: String,
    pub line: usize,
    pub signature: String,
}

#[derive(Clone, Serialize)]
pub struct FileStructure {
    pub path: String,
    pub language: String,
    pub symbols: Vec<SymbolInfo>,
}

#[derive(Clone, Serialize)]
pub struct WorkspaceStructureResult {
    pub files: Vec<FileStructure>,
    pub scanned_count: usize,
    pub total_files: usize,
    pub truncated: bool,
}

#[derive(Clone, Deserialize)]
pub struct ProxySettings {
    pub mode: String,
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub no_proxy: Option<String>,
}
