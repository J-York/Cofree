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
#[tauri::command]
fn validate_git_repo(path: String) -> Result<bool, String> {
    let repo_path = Path::new(&path);
    
    // Check if path exists
    if !repo_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    
    // Try to open as git repository
    match git2::Repository::open(&path) {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

/// Retrieves workspace information including path, git branch, and repository name
#[tauri::command]
fn get_workspace_info(path: String) -> Result<WorkspaceInfo, String> {
    let repo_path = Path::new(&path);
    
    // Validate path exists
    if !repo_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    
    // Try to open git repository
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
        Err(_) => (None, None),
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

/// Reads file content from workspace with path validation
/// Validates that the file path is within the workspace boundary
#[tauri::command]
fn read_workspace_file(
    workspace_path: String,
    relative_path: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
) -> Result<String, String> {
    let file_path = validate_workspace_path(&workspace_path, &relative_path)?;
    
    // Verify it's a file, not a directory
    if !file_path.is_file() {
        return Err("Path is not a file".to_string());
    }

    let content = fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    if start_line.is_none() && end_line.is_none() {
        return Ok(content);
    }

    let segments: Vec<&str> = content.split_inclusive('\n').collect();
    let total_lines = if content.is_empty() { 0 } else { segments.len() };
    if total_lines == 0 {
        return Ok(String::new());
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

    Ok(result)
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
/// Validates workspace is a valid git repository
#[tauri::command]
fn git_status_workspace(workspace_path: String) -> Result<GitStatus, String> {
    let repo = git2::Repository::open(&workspace_path)
        .map_err(|e| format!("Failed to open git repository: {}", e))?;
    
    let mut status_obj = GitStatus {
        modified: Vec::new(),
        added: Vec::new(),
        deleted: Vec::new(),
        untracked: Vec::new(),
    };
    
    // Get status for all files
    let statuses = repo.statuses(None)
        .map_err(|e| format!("Failed to get git status: {}", e))?;
    
    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let status = entry.status();
        
        // Categorize by status flags
        if status.contains(git2::Status::WT_MODIFIED) || status.contains(git2::Status::INDEX_MODIFIED) {
            status_obj.modified.push(path);
        } else if status.contains(git2::Status::WT_NEW) || status.contains(git2::Status::INDEX_NEW) {
            status_obj.added.push(path);
        } else if status.contains(git2::Status::WT_DELETED) || status.contains(git2::Status::INDEX_DELETED) {
            status_obj.deleted.push(path);
        } else if status.contains(git2::Status::IGNORED) {
            // Skip ignored files
        } else if !status.is_empty() {
            // Treat other statuses as untracked
            status_obj.untracked.push(path);
        }
    }
    
    Ok(status_obj)
}

/// Returns unified diff for workspace or specific file
/// If file_path is None, returns diff for all changes
/// If file_path is Some, returns diff for that specific file
#[tauri::command]
fn git_diff_workspace(workspace_path: String, file_path: Option<String>) -> Result<String, String> {
    let workspace = canonicalize_workspace_root(&workspace_path)?;
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
async fn fetch_litellm_models(base_url: String, api_key: String) -> Result<Vec<String>, String> {
    let normalized = normalize_base_url(&base_url);
    if normalized.is_empty() {
        return Err("LiteLLM Base URL 不能为空".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))  // 120 seconds timeout for LLM API calls
        .connect_timeout(Duration::from_secs(10))  // 10 seconds for connection
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败: {}", e))?;

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

#[tauri::command]
async fn post_litellm_chat_completions(
    base_url: String,
    api_key: String,
    body: Value,
) -> Result<LiteLLMHttpResponse, String> {
    let normalized = normalize_base_url(&base_url);
    if normalized.is_empty() {
        return Err("LiteLLM Base URL 不能为空".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))  // 120 seconds timeout for LLM API calls
        .connect_timeout(Duration::from_secs(10))  // 10 seconds for connection
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败: {}", e))?;

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
            save_workflow_checkpoint,
            load_latest_workflow_checkpoint,
            fetch_litellm_models,
            post_litellm_chat_completions,
            load_secure_api_key,
            save_secure_api_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running cofree tauri application");
}

fn main() {
    run();
}
