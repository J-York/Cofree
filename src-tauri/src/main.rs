/*
 * Cofree - AI Programming Cafe
 * File: src-tauri/src/main.rs
 * Milestone: 2.5
 * Task: 2.5.3
 * Status: Completed
 * Owner: Sisyphus-Junior
 * Last Modified: 2026-03-01
 * Description: Tauri entrypoint with workspace folder selection, validation, file operations, git operations, and info retrieval commands.
 */

use glob::glob as glob_match;
use regex::Regex;
use reqwest::header::ACCEPT;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use dirs;
use futures_util::StreamExt;
use tauri::Emitter;

static CHECKPOINT_COUNTER: AtomicU64 = AtomicU64::new(0);
const KEYCHAIN_SERVICE_NAME: &str = "dev.cofree.app";
const KEYCHAIN_ACCOUNT_NAME: &str = "litellm-api-key";

#[derive(Clone, Serialize)]
struct AppHealth {
    status: String,
    milestone: String,
}

/// Workspace metadata information
#[derive(Clone, Serialize)]
struct WorkspaceInfo {
    path: String,
    git_branch: Option<String>,
    repo_name: Option<String>,
}
/// File or directory entry in workspace
#[derive(Clone, Serialize)]
struct FileEntry {
    name: String,
    is_dir: bool,
    size: u64,
    modified: u64,
}

/// Git repository status information
#[derive(Clone, Serialize)]
struct GitStatus {
    modified: Vec<String>,
    added: Vec<String>,
    deleted: Vec<String>,
    untracked: Vec<String>,
}

#[derive(Clone, Serialize)]
struct LiteLLMHttpResponse {
    status: u16,
    body: String,
    endpoint: String,
}

#[derive(Clone, Serialize)]
struct PatchApplyResult {
    success: bool,
    message: String,
    files: Vec<String>,
}

#[derive(Clone, Serialize)]
struct CommandExecutionResult {
    success: bool,
    command: String,
    timed_out: bool,
    status: i32,
    stdout: String,
    stderr: String,
}

#[derive(Clone, Serialize)]
struct SnapshotResult {
    success: bool,
    snapshot_id: String,
    files: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct SnapshotFileRecord {
    path: String,
    existed: bool,
    backup_path: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct SnapshotManifest {
    files: Vec<SnapshotFileRecord>,
}

#[derive(Clone, Serialize)]
struct CheckpointRecord {
    checkpoint_id: String,
    session_id: String,
    message_id: String,
    workflow_state: String,
    payload_json: String,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Serialize)]
struct RecoveryResult {
    found: bool,
    checkpoint: Option<CheckpointRecord>,
}

fn normalize_base_url(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
}

fn load_secure_api_key_macos() -> Result<String, String> {
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            KEYCHAIN_ACCOUNT_NAME,
            "-s",
            KEYCHAIN_SERVICE_NAME,
            "-w",
        ])
        .output()
        .map_err(|e| format!("读取 Keychain 失败: {}", e))?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("could not be found") {
        Ok(String::new())
    } else {
        Err(stderr.trim().to_string())
    }
}

fn save_secure_api_key_macos(api_key: &str) -> Result<(), String> {
    if api_key.trim().is_empty() {
        let _ = Command::new("security")
            .args([
                "delete-generic-password",
                "-a",
                KEYCHAIN_ACCOUNT_NAME,
                "-s",
                KEYCHAIN_SERVICE_NAME,
            ])
            .output();
        return Ok(());
    }

    let output = Command::new("security")
        .args([
            "add-generic-password",
            "-a",
            KEYCHAIN_ACCOUNT_NAME,
            "-s",
            KEYCHAIN_SERVICE_NAME,
            "-w",
            api_key.trim(),
            "-U",
        ])
        .output()
        .map_err(|e| format!("写入 Keychain 失败: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
fn load_secure_api_key() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        load_secure_api_key_macos()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(String::new())
    }
}

#[tauri::command]
fn save_secure_api_key(api_key: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        save_secure_api_key_macos(&api_key)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = api_key;
        Ok(())
    }
}

#[tauri::command]
fn save_file_dialog(file_name: String, content: String) -> Result<String, String> {
    let path = rfd::FileDialog::new()
        .set_file_name(&file_name)
        .save_file()
        .ok_or_else(|| "用户取消了保存".to_string())?;
    fs::write(&path, content.as_bytes())
        .map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

fn canonicalize_workspace_root(workspace_path: &str) -> Result<PathBuf, String> {
    let workspace = PathBuf::from(workspace_path);
    if !workspace.exists() {
        return Err(format!("Workspace path does not exist: {}", workspace_path));
    }
    if !workspace.is_dir() {
        return Err(format!("Workspace path is not a directory: {}", workspace_path));
    }

    workspace
        .canonicalize()
        .map_err(|e| format!("Invalid workspace path: {}", e))
}

fn cofree_home_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())?;
    Ok(home.join(".cofree"))
}

fn sqlite_db_path() -> Result<PathBuf, String> {
    Ok(cofree_home_dir()?.join("checkpoints.db"))
}

fn snapshots_root_dir() -> Result<PathBuf, String> {
    Ok(cofree_home_dir()?.join("snapshots"))
}

fn now_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs().to_string(),
        Err(_) => "0".to_string(),
    }
}

fn ensure_checkpoint_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS workflow_checkpoints (
            checkpoint_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            workflow_state TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_checkpoint_session_updated
          ON workflow_checkpoints(session_id, updated_at DESC);",
    )
    .map_err(|e| format!("初始化 checkpoint 表失败: {}", e))
}

fn generate_checkpoint_id(prefix: &str) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let counter = CHECKPOINT_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}-{}", prefix, nanos, counter)
}

fn extract_error_message(payload: &Value) -> Option<String> {
    if let Some(message) = payload.get("message").and_then(Value::as_str) {
        return Some(message.to_string());
    }

    if let Some(error) = payload.get("error") {
        if let Some(message) = error.as_str() {
            return Some(message.to_string());
        }

        if let Some(message) = error.get("message").and_then(Value::as_str) {
            return Some(message.to_string());
        }
    }

    None
}

fn extract_model_ids(payload: &Value) -> Vec<String> {
    let mut model_ids: Vec<String> = Vec::new();

    let entries: Vec<&Value> = if let Some(array) = payload.as_array() {
        array.iter().collect()
    } else if let Some(array) = payload.get("data").and_then(Value::as_array) {
        array.iter().collect()
    } else {
        Vec::new()
    };

    for entry in entries {
        if let Some(id) = entry.as_str() {
            let trimmed = id.trim();
            if !trimmed.is_empty() {
                model_ids.push(trimmed.to_string());
            }
            continue;
        }

        if let Some(object) = entry.as_object() {
            for key in ["id", "model_name", "model", "name"] {
                if let Some(id) = object.get(key).and_then(Value::as_str) {
                    let trimmed = id.trim();
                    if !trimmed.is_empty() {
                        model_ids.push(trimmed.to_string());
                    }
                    break;
                }
            }
        }
    }

    model_ids.sort();
    model_ids.dedup();
    model_ids
}

async fn fetch_models_from_endpoint(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: &str,
) -> Result<Vec<String>, String> {
    let mut request = client.get(endpoint).header(ACCEPT, "application/json");

    if !api_key.trim().is_empty() {
        request = request.bearer_auth(api_key.trim());
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("{} 请求失败: {}", endpoint, e))?;
    let status = response.status();
    let payload = response.json::<Value>().await.unwrap_or(Value::Null);

    if !status.is_success() {
        let detail = extract_error_message(&payload).unwrap_or_default();
        if detail.is_empty() {
            return Err(format!("{} 返回 HTTP {}", endpoint, status.as_u16()));
        }
        return Err(format!("{} 返回 HTTP {}: {}", endpoint, status.as_u16(), detail));
    }

    let model_ids = extract_model_ids(&payload);
    if model_ids.is_empty() {
        return Err(format!("{} 未返回可用模型", endpoint));
    }

    Ok(model_ids)
}

async fn post_chat_completion_to_endpoint(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: &str,
    body: &Value,
) -> Result<LiteLLMHttpResponse, String> {
    let mut request = client
        .post(endpoint)
        .header(ACCEPT, "application/json")
        .json(body);

    if !api_key.trim().is_empty() {
        request = request.bearer_auth(api_key.trim());
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("{} 请求失败: {}", endpoint, e))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|e| format!("{} 读取响应失败: {}", endpoint, e))?;

    Ok(LiteLLMHttpResponse {
        status,
        body,
        endpoint: endpoint.to_string(),
    })
}


#[tauri::command]
fn healthcheck() -> AppHealth {
    AppHealth {
        status: "ok".to_string(),
        milestone: "1".to_string(),
    }
}

/// Opens native folder picker dialog and returns selected path
/// Returns error if user cancels or dialog fails
#[tauri::command]
fn select_workspace_folder() -> Result<String, String> {
    rfd::FileDialog::new()
        .pick_folder()
        .ok_or_else(|| "No folder selected".to_string())
        .map(|path| path.to_string_lossy().to_string())
}

/// Validates if the given path is a valid git repository
/// Checks for .git directory and valid git repository structure
/// Note: Returns true for all valid directories to allow non-git workspaces
#[tauri::command]
fn validate_git_repo(path: String) -> Result<bool, String> {
    let repo_path = Path::new(&path);

    // Check if path exists
    if !repo_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    // Always return true to allow non-git directories
    Ok(true)
}

/// Retrieves workspace information including path, git branch, and repository name
/// Note: Git info is optional - returns None for non-git directories
#[tauri::command]
fn get_workspace_info(path: String) -> Result<WorkspaceInfo, String> {
    let repo_path = Path::new(&path);

    // Validate path exists
    if !repo_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    // Try to open git repository (optional)
    let (git_branch, repo_name) = match git2::Repository::open(&path) {
        Ok(repo) => {
            // Get current branch
            let branch = repo
                .head()
                .ok()
                .and_then(|head| head.shorthand().map(|s| s.to_string()));

            // Get repository name from path
            let name = repo_path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string());

            (branch, name)
        }
        Err(_) => {
            // For non-git directories, just use directory name
            let name = repo_path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string());
            (None, name)
        },
    };

    Ok(WorkspaceInfo {
        path: path.clone(),
        git_branch,
        repo_name,
    })
}

/// Helper function to validate path is within workspace boundary
fn validate_workspace_path(workspace_path: &str, relative_path: &str) -> Result<PathBuf, String> {
    // Reject absolute paths
    if Path::new(relative_path).is_absolute() {
        return Err("Absolute paths not allowed".to_string());
    }
    
    // Reject paths with ..
    if relative_path.contains("..") {
        return Err("Path traversal (..) not allowed".to_string());
    }
    
    let workspace = canonicalize_workspace_root(workspace_path)?;
    let target = workspace.join(relative_path);
    
    let target_canonical = target
        .canonicalize()
        .map_err(|e| format!("Invalid target path: {}", e))?;
    
    // Ensure target is within workspace
    if !target_canonical.starts_with(&workspace) {
        return Err("Path escapes workspace boundary".to_string());
    }
    
    Ok(target_canonical)
}

fn parse_patch_files(patch: &str) -> Vec<String> {
    let mut files = BTreeSet::new();
    for line in patch.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            for token in rest.split_whitespace().take(2) {
                let normalized = token
                    .strip_prefix("a/")
                    .or_else(|| token.strip_prefix("b/"))
                    .unwrap_or(token)
                    .trim();
                if !normalized.is_empty() && normalized != "/dev/null" {
                    files.insert(normalized.to_string());
                }
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("--- ") {
            let raw = path.trim();
            let trimmed = raw
                .strip_prefix("a/")
                .or_else(|| raw.strip_prefix("b/"))
                .unwrap_or(raw);
            if !trimmed.is_empty() && trimmed != "/dev/null" {
                files.insert(trimmed.to_string());
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("+++ b/") {
            let trimmed = path.trim();
            if !trimmed.is_empty() && trimmed != "/dev/null" {
                files.insert(trimmed.to_string());
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("+++ ") {
            let raw = path.trim();
            let trimmed = raw
                .strip_prefix("a/")
                .or_else(|| raw.strip_prefix("b/"))
                .unwrap_or(raw);
            if !trimmed.is_empty() && trimmed != "/dev/null" {
                files.insert(trimmed.to_string());
            }
        }
    }
    files.into_iter().collect()
}

fn git_has_head(workspace: &Path) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args(["rev-parse", "--verify", "HEAD"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn sanitize_relative_path(relative_path: &str) -> Option<PathBuf> {
    let candidate = PathBuf::from(relative_path.trim());
    if candidate.as_os_str().is_empty() || candidate.is_absolute() {
        return None;
    }

    let mut sanitized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(value) => sanitized.push(value),
            Component::CurDir => {}
            _ => return None,
        }
    }

    if sanitized.as_os_str().is_empty() {
        None
    } else {
        Some(sanitized)
    }
}

fn snapshot_patch_files(
    workspace: &Path,
    snapshot_dir: &Path,
    files: &[String],
) -> Result<Vec<SnapshotFileRecord>, String> {
    let mut records = Vec::new();

    for relative in files {
        let Some(sanitized) = sanitize_relative_path(relative) else {
            continue;
        };
        let relative_string = sanitized.to_string_lossy().to_string();
        let target = workspace.join(&sanitized);

        if target.exists() {
            if !target.is_file() {
                return Err(format!("暂不支持为目录创建文件快照: {}", relative_string));
            }

            let backup_relative = PathBuf::from("files").join(&sanitized);
            let backup_path = snapshot_dir.join(&backup_relative);
            if let Some(parent) = backup_path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建快照目录失败: {}", e))?;
            }
            fs::copy(&target, &backup_path).map_err(|e| {
                format!(
                    "复制文件快照失败: {} -> {} ({})",
                    target.display(),
                    backup_path.display(),
                    e
                )
            })?;
            records.push(SnapshotFileRecord {
                path: relative_string,
                existed: true,
                backup_path: Some(backup_relative.to_string_lossy().to_string()),
            });
        } else {
            records.push(SnapshotFileRecord {
                path: relative_string,
                existed: false,
                backup_path: None,
            });
        }
    }

    Ok(records)
}

fn load_snapshot_manifest(snapshot_path: &Path) -> Result<SnapshotManifest, String> {
    let manifest_path = snapshot_path.join("manifest.json");
    let content = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("读取快照清单失败: {} ({})", manifest_path.display(), e))?;
    serde_json::from_str::<SnapshotManifest>(&content)
        .map_err(|e| format!("解析快照清单失败: {}", e))
}

/// Minimal safety check — only blocks catastrophic/irreversible commands.
/// All other safety is handled by HITL (human-in-the-loop) approval.
/// Result of a grep search across workspace files
#[derive(Clone, Serialize)]
struct GrepMatch {
    file: String,
    line: usize,
    content: String,
}

#[derive(Clone, Serialize)]
struct GrepResult {
    matches: Vec<GrepMatch>,
    truncated: bool,
}

/// Result of a glob file search
#[derive(Clone, Serialize)]
struct GlobEntry {
    path: String,
    size: u64,
    modified: u64,
}

const DEFAULT_IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    "__pycache__",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
];

fn is_ignored_dir(name: &str) -> bool {
    DEFAULT_IGNORED_DIRS.contains(&name)
}

fn walk_workspace_files(root: &Path, max_files: usize) -> Vec<PathBuf> {
    let mut result = Vec::new();
    let mut queue = vec![root.to_path_buf()];

    while let Some(dir) = queue.pop() {
        if result.len() >= max_files {
            break;
        }
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && path != root {
                if is_ignored_dir(&name) {
                    continue;
                }
            }
            if is_ignored_dir(&name) {
                continue;
            }
            if path.is_dir() {
                queue.push(path);
            } else if path.is_file() {
                result.push(path);
                if result.len() >= max_files {
                    break;
                }
            }
        }
    }

    result
}

fn is_likely_binary(path: &Path) -> bool {
    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return true,
    };
    let mut buffer = [0u8; 512];
    let bytes_read = match file.read(&mut buffer) {
        Ok(n) => n,
        Err(_) => return true,
    };
    buffer[..bytes_read].contains(&0)
}

#[tauri::command]
fn grep_workspace_files(
    workspace_path: String,
    pattern: String,
    include_glob: Option<String>,
    max_results: Option<usize>,
) -> Result<GrepResult, String> {
    let workspace = canonicalize_workspace_root(&workspace_path)?;
    if pattern.trim().is_empty() {
        return Err("搜索模式不能为空".to_string());
    }

    let regex = Regex::new(&pattern).map_err(|e| format!("无效的正则表达式: {}", e))?;
    let limit = max_results.unwrap_or(50).min(200);

    let all_files = walk_workspace_files(&workspace, 10000);

    // Optional glob filter for file names
    let include_pattern = include_glob.as_deref().unwrap_or("");
    let glob_filter: Option<glob::Pattern> = if !include_pattern.is_empty() {
        Some(
            glob::Pattern::new(include_pattern)
                .map_err(|e| format!("无效的 glob 模式: {}", e))?,
        )
    } else {
        None
    };

    let mut matches = Vec::new();
    let mut truncated = false;

    for file_path in &all_files {
        if matches.len() >= limit {
            truncated = true;
            break;
        }

        // Apply glob filter on file name
        if let Some(ref gf) = glob_filter {
            let file_name = file_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if !gf.matches(&file_name) {
                // Also try matching against relative path
                let rel = file_path
                    .strip_prefix(&workspace)
                    .unwrap_or(file_path)
                    .to_string_lossy()
                    .to_string();
                if !gf.matches(&rel) {
                    continue;
                }
            }
        }

        // Skip binary files
        if is_likely_binary(file_path) {
            continue;
        }

        let content = match fs::read_to_string(file_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        for (line_idx, line) in content.lines().enumerate() {
            if matches.len() >= limit {
                truncated = true;
                break;
            }
            if regex.is_match(line) {
                let relative = file_path
                    .strip_prefix(&workspace)
                    .unwrap_or(file_path)
                    .to_string_lossy()
                    .to_string();
                let trimmed_line = if line.len() > 500 {
                    format!("{}...", &line[..500])
                } else {
                    line.to_string()
                };
                matches.push(GrepMatch {
                    file: relative,
                    line: line_idx + 1,
                    content: trimmed_line,
                });
            }
        }
    }

    Ok(GrepResult {
        matches,
        truncated,
    })
}

#[tauri::command]
fn glob_workspace_files(
    workspace_path: String,
    pattern: String,
    max_results: Option<usize>,
) -> Result<Vec<GlobEntry>, String> {
    let workspace = canonicalize_workspace_root(&workspace_path)?;
    if pattern.trim().is_empty() {
        return Err("glob 模式不能为空".to_string());
    }

    let limit = max_results.unwrap_or(100).min(500);
    let full_pattern = workspace.join(pattern.trim()).to_string_lossy().to_string();

    let mut entries = Vec::new();

    for entry in glob_match(&full_pattern).map_err(|e| format!("无效的 glob 模式: {}", e))? {
        if entries.len() >= limit {
            break;
        }
        let path = match entry {
            Ok(p) => p,
            Err(_) => continue,
        };

        // Skip ignored directories
        let relative = path
            .strip_prefix(&workspace)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();
        let should_skip = relative
            .split('/')
            .any(|segment| is_ignored_dir(segment));
        if should_skip {
            continue;
        }

        if !path.is_file() {
            continue;
        }

        let metadata = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };

        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        entries.push(GlobEntry {
            path: relative,
            size: metadata.len(),
            modified,
        });
    }

    // Sort by modification time descending (most recent first)
    entries.sort_by(|a, b| b.modified.cmp(&a.modified));

    Ok(entries)
}

fn validate_shell_safety(shell: &str) -> Result<(), String> {
    let lowered = shell.to_lowercase();
    let blocked_patterns = [
        "rm -rf /",
        "rm -rf /*",
        "mkfs",
        "shutdown",
        "reboot",
        ":(){:|:&};:",
    ];
    if blocked_patterns.iter().any(|pattern| lowered.contains(pattern)) {
        return Err("命令命中高风险关键字（系统级破坏性命令），已拒绝执行".to_string());
    }
    Ok(())
}

/// Result of reading a workspace file, including metadata for the orchestrator.
#[derive(serde::Serialize)]
struct ReadFileResult {
    content: String,
    total_lines: usize,
    start_line: usize,
    end_line: usize,
}

/// Reads file content from workspace with path validation
/// Validates that the file path is within the workspace boundary
#[tauri::command]
fn read_workspace_file(
    workspace_path: String,
    relative_path: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
) -> Result<ReadFileResult, String> {
    let file_path = validate_workspace_path(&workspace_path, &relative_path)?;

    // Verify it's a file, not a directory
    if !file_path.is_file() {
        return Err("Path is not a file".to_string());
    }

    let content = fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let segments: Vec<&str> = content.split_inclusive('\n').collect();
    let total_lines = if content.is_empty() { 0 } else { segments.len() };

    if start_line.is_none() && end_line.is_none() {
        return Ok(ReadFileResult {
            content,
            total_lines,
            start_line: 1,
            end_line: total_lines,
        });
    }

    if total_lines == 0 {
        return Ok(ReadFileResult {
            content: String::new(),
            total_lines: 0,
            start_line: 1,
            end_line: 0,
        });
    }

    let start = start_line.unwrap_or(1).max(1);
    let requested_end = end_line.unwrap_or(total_lines).max(1);
    if start > requested_end {
        return Err("start_line 不能大于 end_line".to_string());
    }
    if start > total_lines {
        return Err(format!(
            "start_line 超出文件范围: {} > {}",
            start, total_lines
        ));
    }

    let bounded_end = requested_end.min(total_lines);
    let mut result = String::new();
    for chunk in &segments[(start - 1)..bounded_end] {
        result.push_str(chunk);
    }

    Ok(ReadFileResult {
        content: result,
        total_lines,
        start_line: start,
        end_line: bounded_end,
    })
}

/// Lists files and directories in workspace path (single level)
/// Validates that the directory path is within the workspace boundary
#[tauri::command]
fn list_workspace_files(workspace_path: String, relative_path: String) -> Result<Vec<FileEntry>, String> {
    let dir_path = validate_workspace_path(&workspace_path, &relative_path)?;
    
    // Verify it's a directory
    if !dir_path.is_dir() {
        return Err("Path is not a directory".to_string());
    }
    
    let mut entries = Vec::new();
    
    // Read directory contents (single level only)
    let dir_entries = fs::read_dir(&dir_path)
        .map_err(|e| format!("Failed to read directory: {}", e))?;
    
    for entry in dir_entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();
        
        // Validate entry is still within workspace
        if !path.canonicalize()
            .ok()
            .and_then(|p| dir_path.canonicalize().ok().map(|d| p.starts_with(d)))
            .unwrap_or(false)
        {
            continue; // Skip entries outside workspace
        }
        
        let metadata = entry.metadata()
            .map_err(|e| format!("Failed to get metadata: {}", e))?;
        
        let name = entry.file_name()
            .to_string_lossy()
            .to_string();
        
        let modified = metadata.modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        
        entries.push(FileEntry {
            name,
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            modified,
        });
    }
    
    Ok(entries)
}

/// Returns git status for workspace (modified, added, deleted, untracked files)
/// Returns empty status for non-git directories
#[tauri::command]
fn git_status_workspace(workspace_path: String) -> Result<GitStatus, String> {
    let status_obj = GitStatus {
        modified: Vec::new(),
        added: Vec::new(),
        deleted: Vec::new(),
        untracked: Vec::new(),
    };

    // Try to open git repository
    let repo = match git2::Repository::open(&workspace_path) {
        Ok(repo) => repo,
        Err(_) => {
            // Not a git repository, return empty status
            return Ok(status_obj);
        }
    };

    let mut result = status_obj;

    // Get status for all files
    let statuses = repo.statuses(None)
        .map_err(|e| format!("Failed to get git status: {}", e))?;

    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let status = entry.status();

        // Categorize by status flags
        if status.contains(git2::Status::WT_MODIFIED) || status.contains(git2::Status::INDEX_MODIFIED) {
            result.modified.push(path);
        } else if status.contains(git2::Status::WT_NEW) || status.contains(git2::Status::INDEX_NEW) {
            result.added.push(path);
        } else if status.contains(git2::Status::WT_DELETED) || status.contains(git2::Status::INDEX_DELETED) {
            result.deleted.push(path);
        } else if status.contains(git2::Status::IGNORED) {
            // Skip ignored files
        } else if !status.is_empty() {
            // Treat other statuses as untracked
            result.untracked.push(path);
        }
    }

    Ok(result)
}

/// Returns unified diff for workspace or specific file
/// Returns empty string for non-git directories
#[tauri::command]
fn git_diff_workspace(workspace_path: String, file_path: Option<String>) -> Result<String, String> {
    let workspace = canonicalize_workspace_root(&workspace_path)?;

    // Check if this is a git repository
    if git2::Repository::open(&workspace).is_err() {
        // Not a git repository, return empty diff
        return Ok(String::new());
    }

    let mut args = vec!["diff", "--no-ext-diff"];
    if git_has_head(&workspace) {
        args.push("HEAD");
    }

    let sanitized_file = if let Some(raw_file) = file_path {
        Some(
            sanitize_relative_path(&raw_file)
                .ok_or_else(|| "file_path 非法".to_string())?
                .to_string_lossy()
                .to_string(),
        )
    } else {
        None
    };

    let mut command = Command::new("git");
    command.arg("-C").arg(&workspace).args(&args);
    if let Some(file) = sanitized_file.as_ref() {
        command.arg("--").arg(file);
    }

    let output = command
        .output()
        .map_err(|e| format!("执行 git diff 失败: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "执行 git diff 失败".to_string()
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
fn apply_workspace_patch(workspace_path: String, patch: String) -> Result<PatchApplyResult, String> {
    apply_patch_internal(workspace_path, patch, false)
}

#[tauri::command]
fn check_workspace_patch(workspace_path: String, patch: String) -> Result<PatchApplyResult, String> {
    apply_patch_internal(workspace_path, patch, true)
}

fn apply_patch_internal(
    workspace_path: String,
    patch: String,
    check_only: bool,
) -> Result<PatchApplyResult, String> {
    let workspace = canonicalize_workspace_root(&workspace_path)?;
    if patch.trim().is_empty() {
        return Err("Patch 不能为空".to_string());
    }

    // Try git apply first (works in both git and non-git directories)
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(&workspace)
        .arg("apply")
        .arg("--whitespace=nowarn");
    if check_only {
        command.arg("--check");
    }
    let mut child = command
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if check_only {
                format!("启动 git apply --check 失败: {}", e)
            } else {
                format!("启动 git apply 失败: {}", e)
            }
        })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(patch.as_bytes())
            .map_err(|e| format!("写入 patch 失败: {}", e))?;
    } else {
        return Err("无法获取 git apply stdin".to_string());
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("等待 git apply 完成失败: {}", e))?;
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let files = parse_patch_files(&patch);

    if !output.status.success() {
        let detail = if stderr.is_empty() {
            if check_only {
                "git apply --check 失败".to_string()
            } else {
                "git apply 失败".to_string()
            }
        } else {
            stderr
        };
        return Ok(PatchApplyResult {
            success: false,
            message: detail,
            files,
        });
    }

    Ok(PatchApplyResult {
        success: true,
        message: if check_only {
            format!("Patch 可应用（{} files）", files.len())
        } else {
            format!("Patch 已应用（{} files）", files.len())
        },
        files,
    })
}

#[tauri::command]
fn create_workspace_snapshot(workspace_path: String, patch: Option<String>) -> Result<SnapshotResult, String> {
    let workspace = canonicalize_workspace_root(&workspace_path)?;
    let snapshots_root = snapshots_root_dir()?;
    fs::create_dir_all(&snapshots_root).map_err(|e| format!("创建 snapshots 根目录失败: {}", e))?;

    let files = patch
        .as_deref()
        .map(parse_patch_files)
        .unwrap_or_default();
    let snapshot_id = generate_checkpoint_id("snapshot");
    let snapshot_dir = snapshots_root.join(&snapshot_id);
    fs::create_dir_all(&snapshot_dir).map_err(|e| format!("创建 snapshot 目录失败: {}", e))?;
    let records = snapshot_patch_files(&workspace, &snapshot_dir, &files)?;
    let manifest = SnapshotManifest {
        files: records.clone(),
    };
    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("序列化快照清单失败: {}", e))?;
    fs::write(snapshot_dir.join("manifest.json"), manifest_json)
        .map_err(|e| format!("写入快照清单失败: {}", e))?;

    Ok(SnapshotResult {
        success: true,
        snapshot_id,
        files: records.into_iter().map(|record| record.path).collect(),
    })
}

#[tauri::command]
fn restore_workspace_snapshot(
    workspace_path: String,
    snapshot_id: Option<String>,
) -> Result<PatchApplyResult, String> {
    let workspace = canonicalize_workspace_root(&workspace_path)?;
    let Some(snapshot_id_raw) = snapshot_id else {
        return Ok(PatchApplyResult {
            success: true,
            message: "未提供快照，跳过回滚".to_string(),
            files: Vec::new(),
        });
    };
    if snapshot_id_raw.trim().is_empty() {
        return Ok(PatchApplyResult {
            success: true,
            message: "未提供快照，跳过回滚".to_string(),
            files: Vec::new(),
        });
    }

    let snapshot_path = snapshots_root_dir()?.join(snapshot_id_raw.trim());
    let manifest = load_snapshot_manifest(&snapshot_path)?;
    let mut restored_files = Vec::new();

    for record in manifest.files {
        let Some(sanitized) = sanitize_relative_path(&record.path) else {
            continue;
        };
        let target = workspace.join(&sanitized);

        if record.existed {
            let backup_relative = record
                .backup_path
                .clone()
                .ok_or_else(|| format!("快照缺少备份文件路径: {}", record.path))?;
            let backup_path = snapshot_path.join(&backup_relative);
            if !backup_path.is_file() {
                return Err(format!("快照备份文件不存在: {}", backup_path.display()));
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建恢复目录失败: {}", e))?;
            }
            fs::copy(&backup_path, &target).map_err(|e| {
                format!(
                    "恢复文件失败: {} -> {} ({})",
                    backup_path.display(),
                    target.display(),
                    e
                )
            })?;
        } else if target.is_file() {
            fs::remove_file(&target)
                .map_err(|e| format!("删除新增文件失败: {} ({})", target.display(), e))?;
        }

        restored_files.push(record.path);
    }

    Ok(PatchApplyResult {
        success: true,
        message: format!("已基于文件快照回滚（{} files）", restored_files.len()),
        files: restored_files,
    })
}

#[tauri::command]
fn run_shell_command(
    workspace_path: String,
    shell: String,
    timeout_ms: Option<u64>,
) -> Result<CommandExecutionResult, String> {
    let workspace = canonicalize_workspace_root(&workspace_path)?;
    let shell_trimmed = shell.trim().to_string();
    if shell_trimmed.is_empty() {
        return Err("命令不能为空".to_string());
    }

    validate_shell_safety(&shell_trimmed)?;

    let max_timeout = timeout_ms.unwrap_or(120_000).clamp(1_000, 600_000);
    let timeout = Duration::from_millis(max_timeout);

    let mut child = if cfg!(target_os = "windows") {
        Command::new("powershell")
            .args(["-NoProfile", "-Command", &shell_trimmed])
            .current_dir(&workspace)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("启动 powershell 失败: {}", e))?
    } else {
        Command::new("sh")
            .args(["-c", &shell_trimmed])
            .current_dir(&workspace)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("启动 sh 失败: {}", e))?
    };

    let mut stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| "读取 stdout 失败".to_string())?;
    let mut stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| "读取 stderr 失败".to_string())?;

    let started_at = Instant::now();
    let mut timed_out = false;
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started_at.elapsed() >= timeout {
                    timed_out = true;
                    let _ = child.kill();
                    break child
                        .wait()
                        .map_err(|e| format!("终止超时命令失败: {}", e))?;
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => return Err(format!("等待命令执行失败: {}", error)),
        }
    };

    let mut stdout = String::new();
    let mut stderr = String::new();
    let _ = stdout_pipe.read_to_string(&mut stdout);
    let _ = stderr_pipe.read_to_string(&mut stderr);
    if timed_out {
        if !stderr.ends_with('\n') && !stderr.is_empty() {
            stderr.push('\n');
        }
        stderr.push_str("Command timed out");
    }

    Ok(CommandExecutionResult {
        success: exit_status.success() && !timed_out,
        command: shell_trimmed,
        timed_out,
        status: exit_status.code().unwrap_or(-1),
        stdout,
        stderr,
    })
}


#[tauri::command]
fn save_workflow_checkpoint(
    session_id: String,
    message_id: String,
    workflow_state: String,
    payload_json: String,
) -> Result<CheckpointRecord, String> {
    if session_id.trim().is_empty() || message_id.trim().is_empty() {
        return Err("session_id / message_id 不能为空".to_string());
    }
    if payload_json.trim().is_empty() {
        return Err("payload_json 不能为空".to_string());
    }
    serde_json::from_str::<Value>(&payload_json).map_err(|e| format!("payload_json 不是合法 JSON: {}", e))?;

    let db_path = sqlite_db_path()?;
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 checkpoint 目录失败: {}", e))?;
    }
    let conn = Connection::open(&db_path).map_err(|e| format!("打开 checkpoint DB 失败: {}", e))?;
    ensure_checkpoint_table(&conn)?;

    let checkpoint_id = generate_checkpoint_id("cp");
    let now = now_timestamp();
    conn.execute(
        "INSERT INTO workflow_checkpoints
          (checkpoint_id, session_id, message_id, workflow_state, payload_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            checkpoint_id,
            session_id.trim(),
            message_id.trim(),
            workflow_state.trim(),
            payload_json,
            now,
            now
        ],
    )
    .map_err(|e| format!("保存 checkpoint 失败: {}", e))?;

    Ok(CheckpointRecord {
        checkpoint_id,
        session_id: session_id.trim().to_string(),
        message_id: message_id.trim().to_string(),
        workflow_state: workflow_state.trim().to_string(),
        payload_json,
        created_at: now.clone(),
        updated_at: now,
    })
}

#[tauri::command]
fn load_latest_workflow_checkpoint(session_id: String) -> Result<RecoveryResult, String> {
    if session_id.trim().is_empty() {
        return Err("session_id 不能为空".to_string());
    }
    let db_path = sqlite_db_path()?;
    if !db_path.exists() {
        return Ok(RecoveryResult {
            found: false,
            checkpoint: None,
        });
    }

    let conn = Connection::open(&db_path).map_err(|e| format!("打开 checkpoint DB 失败: {}", e))?;
    ensure_checkpoint_table(&conn)?;

    let mut stmt = conn
        .prepare(
            "SELECT checkpoint_id, session_id, message_id, workflow_state, payload_json, created_at, updated_at
             FROM workflow_checkpoints
             WHERE session_id = ?1
             ORDER BY updated_at DESC
             LIMIT 1",
        )
        .map_err(|e| format!("准备查询 checkpoint 失败: {}", e))?;

    let mut rows = stmt
        .query(params![session_id.trim()])
        .map_err(|e| format!("查询 checkpoint 失败: {}", e))?;

    if let Some(row) = rows.next().map_err(|e| format!("读取 checkpoint 失败: {}", e))? {
        let checkpoint = CheckpointRecord {
            checkpoint_id: row.get(0).map_err(|e| format!("读取 checkpoint_id 失败: {}", e))?,
            session_id: row.get(1).map_err(|e| format!("读取 session_id 失败: {}", e))?,
            message_id: row.get(2).map_err(|e| format!("读取 message_id 失败: {}", e))?,
            workflow_state: row.get(3).map_err(|e| format!("读取 workflow_state 失败: {}", e))?,
            payload_json: row.get(4).map_err(|e| format!("读取 payload_json 失败: {}", e))?,
            created_at: row.get(5).map_err(|e| format!("读取 created_at 失败: {}", e))?,
            updated_at: row.get(6).map_err(|e| format!("读取 updated_at 失败: {}", e))?,
        };
        return Ok(RecoveryResult {
            found: true,
            checkpoint: Some(checkpoint),
        });
    }

    Ok(RecoveryResult {
        found: false,
        checkpoint: None,
    })
}

#[tauri::command]
async fn fetch_litellm_models(
    base_url: String,
    api_key: String,
    proxy: Option<ProxySettings>,
) -> Result<Vec<String>, String> {
    let normalized = normalize_base_url(&base_url);
    if normalized.is_empty() {
        return Err("LiteLLM Base URL 不能为空".to_string());
    }

    let client = build_reqwest_client_with_proxy(proxy, 120)?;

    let mut endpoints = vec![format!("{}/models", normalized)];
    if !normalized.ends_with("/v1") {
        endpoints.push(format!("{}/v1/models", normalized));
    }

    let mut errors = Vec::new();
    for endpoint in endpoints {
        match fetch_models_from_endpoint(&client, &endpoint, &api_key).await {
            Ok(models) => return Ok(models),
            Err(error) => errors.push(error),
        }
    }

    Err(format!("拉取模型失败: {}", errors.join(" | ")))
}

#[derive(Clone, Deserialize)]
struct ProxySettings {
    mode: String,
    url: String,
    username: Option<String>,
    password: Option<String>,
    no_proxy: Option<String>,
}

fn build_reqwest_client_with_proxy(
    proxy: Option<ProxySettings>,
    timeout_secs: u64,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .connect_timeout(Duration::from_secs(10));

    if let Some(proxy_cfg) = proxy {
        let mode = proxy_cfg.mode.trim().to_lowercase();
        if mode != "off" {
            let raw_url = proxy_cfg.url.trim();
            if raw_url.is_empty() {
                return Err("代理已启用，但未填写代理 URL".to_string());
            }

            // reqwest expects scheme in the URL. For convenience, if user chose a mode but omitted scheme,
            // we will prepend it.
            let url_with_scheme = if raw_url.starts_with("http://")
                || raw_url.starts_with("https://")
                || raw_url.starts_with("socks5://")
                || raw_url.starts_with("socks5h://")
            {
                raw_url.to_string()
            } else {
                format!("{}://{}", mode, raw_url)
            };

            let mut pxy = reqwest::Proxy::all(&url_with_scheme)
                .map_err(|e| format!("代理地址无效: {}", e))?;

            if let (Some(user), Some(pass)) = (proxy_cfg.username, proxy_cfg.password) {
                if !user.trim().is_empty() {
                    pxy = pxy.basic_auth(user.trim(), pass.trim());
                }
            }

            builder = builder.proxy(pxy);

            if let Some(no_proxy) = proxy_cfg.no_proxy {
                // Best-effort: `reqwest` exposes only `ClientBuilder::no_proxy()` (disable proxy entirely)
                // and reads NO_PROXY from env; it doesn't accept a custom list via builder.
                // So here we set NO_PROXY env var for this process.
                let cleaned = no_proxy
                    .split(',')
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(",");
                if !cleaned.is_empty() {
                    std::env::set_var("NO_PROXY", cleaned);
                }
            }
        }
    }

    builder
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败: {}", e))
}

#[tauri::command]
async fn post_litellm_chat_completions(
    base_url: String,
    api_key: String,
    body: Value,
    proxy: Option<ProxySettings>,
) -> Result<LiteLLMHttpResponse, String> {
    let normalized = normalize_base_url(&base_url);
    if normalized.is_empty() {
        return Err("LiteLLM Base URL 不能为空".to_string());
    }

    let client = build_reqwest_client_with_proxy(proxy, 120)?;

    let mut endpoints = vec![format!("{}/chat/completions", normalized)];
    if !normalized.ends_with("/v1") {
        endpoints.push(format!("{}/v1/chat/completions", normalized));
    }

    let mut errors = Vec::new();
    for (index, endpoint) in endpoints.iter().enumerate() {
        match post_chat_completion_to_endpoint(&client, endpoint, &api_key, &body).await {
            Ok(response) => {
                if response.status == 404 && index + 1 < endpoints.len() {
                    errors.push(format!("{} 返回 HTTP 404", endpoint));
                    continue;
                }
                return Ok(response);
            }
            Err(error) => errors.push(error),
        }
    }

    Err(format!("请求 chat/completions 失败: {}", errors.join(" | ")))
}

#[derive(Clone, Serialize)]
struct StreamChunkEvent {
    request_id: String,
    content: String,
    done: bool,
    finish_reason: Option<String>,
}

#[tauri::command]
async fn post_litellm_chat_completions_stream(
    app: tauri::AppHandle,
    base_url: String,
    api_key: String,
    body: Value,
    request_id: String,
    proxy: Option<ProxySettings>,
) -> Result<LiteLLMHttpResponse, String> {
    let normalized = normalize_base_url(&base_url);
    if normalized.is_empty() {
        return Err("LiteLLM Base URL 不能为空".to_string());
    }

    let client = build_reqwest_client_with_proxy(proxy, 300)?;

    // Force stream: true in the body
    let mut stream_body = body.clone();
    if let Some(obj) = stream_body.as_object_mut() {
        obj.insert("stream".to_string(), Value::Bool(true));
    }

    let mut endpoints = vec![format!("{}/chat/completions", normalized)];
    if !normalized.ends_with("/v1") {
        endpoints.push(format!("{}/v1/chat/completions", normalized));
    }

    let mut errors = Vec::new();

    for (index, endpoint) in endpoints.iter().enumerate() {
        let mut request = client
            .post(endpoint)
            .header(ACCEPT, "text/event-stream")
            .json(&stream_body);

        if !api_key.trim().is_empty() {
            request = request.bearer_auth(api_key.trim());
        }

        let response = match request.send().await {
            Ok(r) => r,
            Err(e) => {
                errors.push(format!("{} 请求失败: {}", endpoint, e));
                continue;
            }
        };

        let status = response.status().as_u16();

        // If 404 and more endpoints to try, continue
        if status == 404 && index + 1 < endpoints.len() {
            errors.push(format!("{} 返回 HTTP 404", endpoint));
            continue;
        }

        // If non-success, read body and return error response
        if !response.status().is_success() {
            let body_text = response.text().await.unwrap_or_default();
            return Ok(LiteLLMHttpResponse {
                status,
                body: body_text,
                endpoint: endpoint.to_string(),
            });
        }

        // Stream SSE response
        let mut full_content = String::new();
        let mut finish_reason: Option<String> = None;
        let mut tool_calls_json: Vec<Value> = Vec::new();
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk_result) = stream.next().await {
            let chunk = match chunk_result {
                Ok(c) => c,
                Err(e) => {
                    errors.push(format!("读取流数据失败: {}", e));
                    break;
                }
            };

            buffer.push_str(&String::from_utf8_lossy(&chunk));

            // Process complete SSE lines
            while let Some(newline_pos) = buffer.find('\n') {
                let line = buffer[..newline_pos].trim().to_string();
                buffer = buffer[newline_pos + 1..].to_string();

                if line.is_empty() || line.starts_with(':') {
                    continue;
                }

                if line == "data: [DONE]" {
                    let _ = app.emit("llm-stream-chunk", StreamChunkEvent {
                        request_id: request_id.clone(),
                        content: String::new(),
                        done: true,
                        finish_reason: finish_reason.clone(),
                    });
                    continue;
                }

                if let Some(data) = line.strip_prefix("data: ") {
                    if let Ok(parsed) = serde_json::from_str::<Value>(data) {
                        // Extract delta content
                        if let Some(choices) = parsed.get("choices").and_then(Value::as_array) {
                            for choice in choices {
                                if let Some(delta) = choice.get("delta") {
                                    if let Some(content) = delta.get("content").and_then(Value::as_str) {
                                        full_content.push_str(content);
                                        let _ = app.emit("llm-stream-chunk", StreamChunkEvent {
                                            request_id: request_id.clone(),
                                            content: content.to_string(),
                                            done: false,
                                            finish_reason: None,
                                        });
                                    }
                                    // Accumulate tool_calls deltas
                                    if let Some(tc) = delta.get("tool_calls").and_then(Value::as_array) {
                                        for tool_call_delta in tc {
                                            let tc_index = tool_call_delta.get("index")
                                                .and_then(Value::as_u64)
                                                .unwrap_or(0) as usize;
                                            while tool_calls_json.len() <= tc_index {
                                                tool_calls_json.push(serde_json::json!({
                                                    "id": "",
                                                    "type": "function",
                                                    "function": { "name": "", "arguments": "" }
                                                }));
                                            }
                                            let tc_entry = &mut tool_calls_json[tc_index];
                                            if let Some(id) = tool_call_delta.get("id").and_then(Value::as_str) {
                                                tc_entry["id"] = Value::String(id.to_string());
                                            }
                                            if let Some(func) = tool_call_delta.get("function") {
                                                if let Some(name) = func.get("name").and_then(Value::as_str) {
                                                    tc_entry["function"]["name"] = Value::String(name.to_string());
                                                }
                                                if let Some(args) = func.get("arguments").and_then(Value::as_str) {
                                                    if let Some(existing) = tc_entry["function"]["arguments"].as_str() {
                                                        tc_entry["function"]["arguments"] = Value::String(format!("{}{}", existing, args));
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                                if let Some(fr) = choice.get("finish_reason").and_then(Value::as_str) {
                                    finish_reason = Some(fr.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }

        // Build a synthetic non-streaming response for compatibility
        let mut message = serde_json::json!({
            "role": "assistant",
            "content": full_content,
        });
        if !tool_calls_json.is_empty() {
            message["tool_calls"] = Value::Array(tool_calls_json);
        }
        let synthetic_response = serde_json::json!({
            "choices": [{
                "message": message,
                "finish_reason": finish_reason.unwrap_or_else(|| "stop".to_string()),
            }],
            "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
        });

        return Ok(LiteLLMHttpResponse {
            status,
            body: serde_json::to_string(&synthetic_response).unwrap_or_default(),
            endpoint: endpoint.to_string(),
        });
    }

    Err(format!("请求 streaming chat/completions 失败: {}", errors.join(" | ")))
}

#[derive(Clone, Serialize)]
struct DiagnosticEntry {
    file: String,
    line: usize,
    column: usize,
    severity: String,
    message: String,
}

#[derive(Clone, Serialize)]
struct DiagnosticsResult {
    success: bool,
    diagnostics: Vec<DiagnosticEntry>,
    tool_used: String,
    raw_output: String,
}

fn detect_project_type(workspace: &Path) -> &'static str {
    if workspace.join("tsconfig.json").exists() || workspace.join("package.json").exists() {
        return "typescript";
    }
    if workspace.join("Cargo.toml").exists() {
        return "rust";
    }
    if workspace.join("pyproject.toml").exists()
        || workspace.join("setup.py").exists()
        || workspace.join("requirements.txt").exists()
    {
        return "python";
    }
    if workspace.join("go.mod").exists() {
        return "go";
    }
    "unknown"
}

fn parse_tsc_diagnostics(output: &str) -> Vec<DiagnosticEntry> {
    let mut entries = Vec::new();
    let re = Regex::new(r"^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+\w+:\s*(.+)$").unwrap();
    for line in output.lines() {
        if let Some(caps) = re.captures(line.trim()) {
            entries.push(DiagnosticEntry {
                file: caps[1].to_string(),
                line: caps[2].parse().unwrap_or(0),
                column: caps[3].parse().unwrap_or(0),
                severity: caps[4].to_string(),
                message: caps[5].to_string(),
            });
        }
    }
    entries
}

fn parse_cargo_diagnostics(output: &str) -> Vec<DiagnosticEntry> {
    let mut entries = Vec::new();
    let re = Regex::new(r"^(error|warning)(?:\[E\d+\])?: (.+)$").unwrap();
    let loc_re = Regex::new(r"^\s*--> (.+?):(\d+):(\d+)$").unwrap();
    let mut pending_severity = String::new();
    let mut pending_message = String::new();

    for line in output.lines() {
        if let Some(caps) = re.captures(line) {
            pending_severity = caps[1].to_string();
            pending_message = caps[2].to_string();
        } else if let Some(caps) = loc_re.captures(line) {
            if !pending_message.is_empty() {
                entries.push(DiagnosticEntry {
                    file: caps[1].to_string(),
                    line: caps[2].parse().unwrap_or(0),
                    column: caps[3].parse().unwrap_or(0),
                    severity: pending_severity.clone(),
                    message: pending_message.clone(),
                });
                pending_message.clear();
            }
        }
    }
    entries
}

#[tauri::command]
fn get_workspace_diagnostics(
    workspace_path: String,
    changed_files: Option<Vec<String>>,
) -> Result<DiagnosticsResult, String> {
    let workspace = canonicalize_workspace_root(&workspace_path)?;
    let project_type = detect_project_type(&workspace);

    let (tool_name, output) = match project_type {
        "typescript" => {
            let npx_result = Command::new("npx")
                .args(["tsc", "--noEmit", "--pretty", "false"])
                .current_dir(&workspace)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output();
            match npx_result {
                Ok(out) => {
                    let combined = format!(
                        "{}{}",
                        String::from_utf8_lossy(&out.stdout),
                        String::from_utf8_lossy(&out.stderr)
                    );
                    ("tsc --noEmit", combined)
                }
                Err(_) => ("none", String::new()),
            }
        }
        "rust" => {
            let cargo_result = Command::new("cargo")
                .args(["check", "--message-format=short"])
                .current_dir(&workspace)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output();
            match cargo_result {
                Ok(out) => {
                    let combined = format!(
                        "{}{}",
                        String::from_utf8_lossy(&out.stdout),
                        String::from_utf8_lossy(&out.stderr)
                    );
                    ("cargo check", combined)
                }
                Err(_) => ("none", String::new()),
            }
        }
        "python" => {
            if let Some(ref files) = changed_files {
                let py_files: Vec<&String> = files.iter().filter(|f| f.ends_with(".py")).collect();
                if py_files.is_empty() {
                    ("none", String::new())
                } else {
                    let mut combined = String::new();
                    for py_file in py_files.iter().take(10) {
                        let result = Command::new("python3")
                            .args(["-m", "py_compile", py_file])
                            .current_dir(&workspace)
                            .stdout(Stdio::piped())
                            .stderr(Stdio::piped())
                            .output();
                        if let Ok(out) = result {
                            combined.push_str(&String::from_utf8_lossy(&out.stderr));
                        }
                    }
                    ("python3 -m py_compile", combined)
                }
            } else {
                ("none", String::new())
            }
        }
        _ => ("none", String::new()),
    };

    if tool_name == "none" {
        return Ok(DiagnosticsResult {
            success: true,
            diagnostics: Vec::new(),
            tool_used: "none".to_string(),
            raw_output: String::new(),
        });
    }

    let diagnostics = match project_type {
        "typescript" => parse_tsc_diagnostics(&output),
        "rust" => parse_cargo_diagnostics(&output),
        _ => Vec::new(),
    };

    // Filter diagnostics to only changed files if specified
    let filtered = if let Some(ref files) = changed_files {
        let file_set: std::collections::HashSet<&str> = files.iter().map(|f| f.as_str()).collect();
        diagnostics
            .into_iter()
            .filter(|d| file_set.contains(d.file.as_str()))
            .collect()
    } else {
        diagnostics
    };

    let truncated_output = if output.len() > 3000 {
        format!("{}...(truncated)", &output[..3000])
    } else {
        output
    };

    Ok(DiagnosticsResult {
        success: true,
        diagnostics: filtered,
        tool_used: tool_name.to_string(),
        raw_output: truncated_output,
    })
}

#[derive(Clone, Serialize)]
struct FetchResult {
    success: bool,
    url: String,
    content_type: Option<String>,
    content: String,
    truncated: bool,
    error: Option<String>,
}

const FETCH_ALLOWED_DOMAINS: &[&str] = &[
    "api.github.com",
    "raw.githubusercontent.com",
    "docs.rs",
    "doc.rust-lang.org",
    "npmjs.com",
    "www.npmjs.com",
    "registry.npmjs.org",
    "pypi.org",
    "stackoverflow.com",
    "developer.mozilla.org",
    "crates.io",
    "pkg.go.dev",
    "docs.python.org",
    "nodejs.org",
    "typescriptlang.org",
    "www.typescriptlang.org",
    "reactjs.org",
    "react.dev",
    "vuejs.org",
    "angular.io",
    "svelte.dev",
    "nextjs.org",
    "deno.land",
    "bun.sh",
];

fn is_domain_allowed(url: &str) -> bool {
    let parsed = match url::Url::parse(url) {
        Ok(u) => u,
        Err(_) => return false,
    };
    let host = match parsed.host_str() {
        Some(h) => h.to_lowercase(),
        None => return false,
    };
    FETCH_ALLOWED_DOMAINS.iter().any(|allowed| {
        host == *allowed || host.ends_with(&format!(".{}", allowed))
    })
}

#[tauri::command]
async fn fetch_url(
    url: String,
    max_size: Option<usize>,
    proxy: Option<ProxySettings>,
) -> Result<FetchResult, String> {
    let url_trimmed = url.trim();
    if url_trimmed.is_empty() {
        return Err("URL 不能为空".to_string());
    }

    if !is_domain_allowed(url_trimmed) {
        return Ok(FetchResult {
            success: false,
            url: url_trimmed.to_string(),
            content_type: None,
            content: String::new(),
            truncated: false,
            error: Some(format!(
                "域名不在白名单中。允许的域名: {}",
                FETCH_ALLOWED_DOMAINS.join(", ")
            )),
        });
    }

    let max_bytes = max_size.unwrap_or(512 * 1024).min(512 * 1024);
    let client = build_reqwest_client_with_proxy(proxy, 30)?;

    let response = client
        .get(url_trimmed)
        .header(ACCEPT, "text/html,application/json,text/plain,*/*")
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        return Ok(FetchResult {
            success: false,
            url: url_trimmed.to_string(),
            content_type: None,
            content: String::new(),
            truncated: false,
            error: Some(format!("HTTP {}", status.as_u16())),
        });
    }

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    let truncated = bytes.len() > max_bytes;
    let content_bytes = if truncated {
        &bytes[..max_bytes]
    } else {
        &bytes[..]
    };

    let content = String::from_utf8_lossy(content_bytes).to_string();

    Ok(FetchResult {
        success: true,
        url: url_trimmed.to_string(),
        content_type,
        content,
        truncated,
        error: None,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            healthcheck,
            select_workspace_folder,
            validate_git_repo,
            get_workspace_info,
            read_workspace_file,
            list_workspace_files,
            git_status_workspace,
            git_diff_workspace,
            apply_workspace_patch,
            check_workspace_patch,
            create_workspace_snapshot,
            restore_workspace_snapshot,
            run_shell_command,
            grep_workspace_files,
            glob_workspace_files,
            save_workflow_checkpoint,
            load_latest_workflow_checkpoint,
            fetch_litellm_models,
            post_litellm_chat_completions,
            post_litellm_chat_completions_stream,
            load_secure_api_key,
            save_secure_api_key,
            save_file_dialog,
            get_workspace_diagnostics,
            fetch_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running cofree tauri application");
}

fn main() {
    run();
}
