/*
 * Cofree - AI Programming Cafe
 * File: src-tauri/src/main.rs
 * Milestone: 2.5
 * Task: 2.5.3
 * Status: Completed
 * Owner: Sisyphus-Junior
 * Last Modified: 2026-02-27
 * Description: Tauri entrypoint with workspace folder selection, validation, file operations, git operations, and info retrieval commands.
 */

use reqwest::header::ACCEPT;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

static CHECKPOINT_COUNTER: AtomicU64 = AtomicU64::new(0);

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
struct GitWriteResult {
    success: bool,
    operation: String,
    message: String,
    branch: Option<String>,
    commit_oid: Option<String>,
}

#[derive(Clone, Serialize)]
struct SnapshotResult {
    success: bool,
    snapshot_id: String,
    status: String,
    diff: String,
    untracked_files: Vec<String>,
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

fn sqlite_db_path() -> Result<PathBuf, String> {
    let root = std::env::current_dir().map_err(|e| format!("读取当前目录失败: {}", e))?;
    Ok(root.join(".cofree").join("checkpoints.db"))
}

fn snapshots_root_dir() -> Result<PathBuf, String> {
    let root = std::env::current_dir().map_err(|e| format!("读取当前目录失败: {}", e))?;
    Ok(root.join(".cofree").join("snapshots"))
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
        if let Some(path) = line.strip_prefix("+++ b/") {
            let trimmed = path.trim();
            if !trimmed.is_empty() && trimmed != "/dev/null" {
                files.insert(trimmed.to_string());
            }
        }
    }
    files.into_iter().collect()
}

fn is_allowlisted_command(command: &str) -> bool {
    matches!(
        command.trim(),
        "pnpm build"
            | "pnpm test"
            | "npm run build"
            | "npm test"
            | "cargo check"
            | "cargo test"
            | "bun test"
    )
}

fn run_git_capture_output(workspace: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args(args)
        .output()
        .map_err(|e| format!("执行 git {:?} 失败: {}", args, e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn run_git_expect_success(workspace: &Path, args: &[&str]) -> Result<(), String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args(args)
        .output()
        .map_err(|e| format!("执行 git {:?} 失败: {}", args, e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
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

fn list_untracked_files(workspace: &Path) -> Result<Vec<String>, String> {
    let output = run_git_capture_output(workspace, &["ls-files", "--others", "--exclude-standard"])?;
    let mut files = BTreeSet::new();
    for raw_line in output.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(path) = sanitize_relative_path(line) {
            files.insert(path.to_string_lossy().to_string());
        }
    }
    Ok(files.into_iter().collect())
}

fn copy_untracked_to_snapshot(
    workspace: &Path,
    snapshot_dir: &Path,
    untracked_files: &[String],
) -> Result<(), String> {
    for relative in untracked_files {
        let Some(sanitized) = sanitize_relative_path(relative) else {
            continue;
        };
        let source = workspace.join(&sanitized);
        if !source.is_file() {
            continue;
        }
        let destination = snapshot_dir.join(&sanitized);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建快照目录失败: {}", e))?;
        }
        fs::copy(&source, &destination).map_err(|e| {
            format!(
                "复制 untracked 文件到快照失败: {} -> {} ({})",
                source.display(),
                destination.display(),
                e
            )
        })?;
    }
    Ok(())
}

fn restore_untracked_from_snapshot(workspace: &Path, snapshot_dir: &Path) -> Result<usize, String> {
    if !snapshot_dir.exists() {
        return Ok(0);
    }

    let mut restored = 0usize;
    let mut stack = vec![snapshot_dir.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let entries = fs::read_dir(&directory)
            .map_err(|e| format!("读取快照目录失败: {} ({})", directory.display(), e))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("读取快照文件失败: {}", e))?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }

            if !path.is_file() {
                continue;
            }

            let relative = path
                .strip_prefix(snapshot_dir)
                .map_err(|e| format!("计算快照相对路径失败: {}", e))?;
            let target = workspace.join(relative);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建恢复目录失败: {}", e))?;
            }
            fs::copy(&path, &target).map_err(|e| {
                format!(
                    "恢复 untracked 文件失败: {} -> {} ({})",
                    path.display(),
                    target.display(),
                    e
                )
            })?;
            restored += 1;
        }
    }

    Ok(restored)
}

/// Reads file content from workspace with path validation
/// Validates that the file path is within the workspace boundary
#[tauri::command]
fn read_workspace_file(workspace_path: String, relative_path: String) -> Result<String, String> {
    let file_path = validate_workspace_path(&workspace_path, &relative_path)?;
    
    // Verify it's a file, not a directory
    if !file_path.is_file() {
        return Err("Path is not a file".to_string());
    }
    
    fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))
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
    let repo = git2::Repository::open(&workspace_path)
        .map_err(|e| format!("Failed to open git repository: {}", e))?;
    
    // Get the HEAD tree for comparison
    let head = repo.head()
        .map_err(|e| format!("Failed to get HEAD: {}", e))?;
    
    let head_tree = head.peel_to_tree()
        .map_err(|e| format!("Failed to get HEAD tree: {}", e))?;
    
    // Create diff between HEAD and working directory
    let diff = repo.diff_tree_to_workdir(Some(&head_tree), None)
        .map_err(|e| format!("Failed to create diff: {}", e))?;
    
    let mut diff_str = String::new();
    
    // Iterate through diff deltas
    for delta in diff.deltas() {
        let patch_path = delta.new_file().path()
            .and_then(|p| p.to_str())
            .unwrap_or("");
        
        // Skip if specific file requested and doesn't match
        if let Some(ref file) = file_path {
            if patch_path != file {
                continue;
            }
        }
        
        // Add delta header
        diff_str.push_str(&format!("diff --git a/{} b/{}\n", patch_path, patch_path));
        diff_str.push_str(&format!("index {}..{}\n", 
            delta.old_file().id().to_string()[..7].to_string(),
            delta.new_file().id().to_string()[..7].to_string()));
        diff_str.push_str(&format!("--- a/{}\n", patch_path));
        diff_str.push_str(&format!("+++ b/{}\n", patch_path));
    }
    
    Ok(diff_str)
}

#[tauri::command]
fn apply_workspace_patch(workspace_path: String, patch: String) -> Result<PatchApplyResult, String> {
    let workspace = canonicalize_workspace_root(&workspace_path)?;
    if patch.trim().is_empty() {
        return Err("Patch 不能为空".to_string());
    }

    let mut child = Command::new("git")
        .arg("-C")
        .arg(&workspace)
        .arg("apply")
        .arg("--whitespace=nowarn")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 git apply 失败: {}", e))?;

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
            "git apply 失败".to_string()
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
        message: format!("Patch 已应用（{} files）", files.len()),
        files,
    })
}

#[tauri::command]
fn create_workspace_snapshot(workspace_path: String) -> Result<SnapshotResult, String> {
    let workspace = canonicalize_workspace_root(&workspace_path)?;
    let snapshots_root = snapshots_root_dir()?;
    fs::create_dir_all(&snapshots_root).map_err(|e| format!("创建 snapshots 根目录失败: {}", e))?;

    let status = run_git_capture_output(&workspace, &["status", "--short"])?;
    let diff = run_git_capture_output(&workspace, &["diff"])?;
    let untracked_files = list_untracked_files(&workspace)?;
    let snapshot_id = generate_checkpoint_id("snapshot");
    let snapshot_dir = snapshots_root.join(&snapshot_id);
    fs::create_dir_all(&snapshot_dir).map_err(|e| format!("创建 snapshot 目录失败: {}", e))?;
    copy_untracked_to_snapshot(&workspace, &snapshot_dir, &untracked_files)?;

    Ok(SnapshotResult {
        success: true,
        snapshot_id,
        status,
        diff,
        untracked_files,
    })
}

#[tauri::command]
fn restore_workspace_snapshot(
    workspace_path: String,
    diff: String,
    snapshot_id: Option<String>,
) -> Result<PatchApplyResult, String> {
    let workspace = canonicalize_workspace_root(&workspace_path)?;
    // Rollback strategy:
    // 1) Reset tracked files to HEAD.
    // 2) Clean untracked files/directories.
    // 3) Re-apply tracked diff snapshot.
    // 4) Restore untracked file backups from snapshot directory.
    run_git_expect_success(&workspace, &["reset", "--hard", "HEAD"])?;
    run_git_expect_success(&workspace, &["clean", "-fd"])?;

    if !diff.trim().is_empty() {
        let mut child = Command::new("git")
            .arg("-C")
            .arg(&workspace)
            .arg("apply")
            .arg("--whitespace=nowarn")
            .arg("-")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("启动 git apply 恢复快照失败: {}", e))?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(diff.as_bytes())
                .map_err(|e| format!("写入快照 diff 失败: {}", e))?;
        } else {
            return Err("无法获取快照恢复 stdin".to_string());
        }

        let output = child
            .wait_with_output()
            .map_err(|e| format!("等待快照恢复完成失败: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Ok(PatchApplyResult {
                success: false,
                message: if stderr.is_empty() {
                    "恢复快照失败".to_string()
                } else {
                    stderr
                },
                files: parse_patch_files(&diff),
            });
        }
    }

    let restored_untracked_count = if let Some(snapshot_id_raw) = snapshot_id {
        if snapshot_id_raw.trim().is_empty() {
            0
        } else {
            let snapshot_path = snapshots_root_dir()?.join(snapshot_id_raw.trim());
            restore_untracked_from_snapshot(&workspace, &snapshot_path)?
        }
    } else {
        0
    };

    Ok(PatchApplyResult {
        success: true,
        message: format!(
            "已恢复到快照前状态（tracked + {} untracked files）",
            restored_untracked_count
        ),
        files: parse_patch_files(&diff),
    })
}

#[tauri::command]
fn run_workspace_command(
    workspace_path: String,
    command: String,
    timeout_ms: Option<u64>,
) -> Result<CommandExecutionResult, String> {
    let workspace = canonicalize_workspace_root(&workspace_path)?;
    let command_trimmed = command.trim().to_string();
    if command_trimmed.is_empty() {
        return Err("命令不能为空".to_string());
    }
    if !is_allowlisted_command(&command_trimmed) {
        return Err(format!("命令不在 allowlist: {}", command_trimmed));
    }

    let max_timeout = timeout_ms.unwrap_or(120_000).clamp(1_000, 600_000);
    let timeout = Duration::from_millis(max_timeout);

    let mut child = Command::new("/bin/zsh")
        .arg("-lc")
        .arg(&command_trimmed)
        .current_dir(&workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动命令失败: {}", e))?;

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
        command: command_trimmed,
        timed_out,
        status: exit_status.code().unwrap_or(-1),
        stdout,
        stderr,
    })
}

#[tauri::command]
fn git_write_workspace(
    workspace_path: String,
    operation: String,
    message: Option<String>,
    branch_name: Option<String>,
    allow_empty: Option<bool>,
) -> Result<GitWriteResult, String> {
    let repo = git2::Repository::open(&workspace_path)
        .map_err(|e| format!("Failed to open git repository: {}", e))?;
    let operation_trimmed = operation.trim().to_string();

    match operation_trimmed.as_str() {
        "stage" => {
            let mut index = repo
                .index()
                .map_err(|e| format!("读取 git index 失败: {}", e))?;
            index
                .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
                .map_err(|e| format!("stage 失败: {}", e))?;
            index
                .write()
                .map_err(|e| format!("写入 git index 失败: {}", e))?;

            Ok(GitWriteResult {
                success: true,
                operation: "stage".to_string(),
                message: "已 stage 当前工作区变更".to_string(),
                branch: None,
                commit_oid: None,
            })
        }
        "commit" => {
            let commit_message = message
                .unwrap_or_else(|| "chore: apply approved changes".to_string())
                .trim()
                .to_string();
            if commit_message.is_empty() {
                return Err("Commit message 不能为空".to_string());
            }

            let mut index = repo
                .index()
                .map_err(|e| format!("读取 git index 失败: {}", e))?;
            index
                .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
                .map_err(|e| format!("stage for commit 失败: {}", e))?;
            index
                .write()
                .map_err(|e| format!("写入 git index 失败: {}", e))?;

            let tree_oid = index
                .write_tree()
                .map_err(|e| format!("生成 commit tree 失败: {}", e))?;
            let tree = repo
                .find_tree(tree_oid)
                .map_err(|e| format!("读取 commit tree 失败: {}", e))?;

            let parent_commit = repo
                .head()
                .ok()
                .and_then(|head| head.target())
                .and_then(|oid| repo.find_commit(oid).ok());

            if !allow_empty.unwrap_or(false) {
                if let Some(parent) = parent_commit.as_ref() {
                    if parent.tree_id() == tree_oid {
                        return Err("没有可提交的变更".to_string());
                    }
                }
            }

            let signature = repo.signature().or_else(|_| {
                git2::Signature::now("Cofree", "cofree@local.dev")
                    .map_err(|e| git2::Error::from_str(&e.to_string()))
            })
            .map_err(|e| format!("创建 git signature 失败: {}", e))?;

            let oid = if let Some(parent) = parent_commit.as_ref() {
                repo.commit(
                    Some("HEAD"),
                    &signature,
                    &signature,
                    &commit_message,
                    &tree,
                    &[parent],
                )
                .map_err(|e| format!("创建 commit 失败: {}", e))?
            } else {
                repo.commit(
                    Some("HEAD"),
                    &signature,
                    &signature,
                    &commit_message,
                    &tree,
                    &[],
                )
                .map_err(|e| format!("创建初始 commit 失败: {}", e))?
            };

            Ok(GitWriteResult {
                success: true,
                operation: "commit".to_string(),
                message: commit_message,
                branch: None,
                commit_oid: Some(oid.to_string()),
            })
        }
        "checkout_branch" => {
            let branch = branch_name
                .unwrap_or_else(|| "cofree/m3-approved".to_string())
                .trim()
                .to_string();
            if branch.is_empty() {
                return Err("Branch 名称不能为空".to_string());
            }

            let reference_name = format!("refs/heads/{}", branch);
            if repo.find_reference(&reference_name).is_err() {
                let head_commit = repo
                    .head()
                    .map_err(|e| format!("读取 HEAD 失败: {}", e))?
                    .peel_to_commit()
                    .map_err(|e| format!("读取 HEAD commit 失败: {}", e))?;
                repo.branch(&branch, &head_commit, false)
                    .map_err(|e| format!("创建分支失败: {}", e))?;
            }

            repo.set_head(&reference_name)
                .map_err(|e| format!("切换分支失败: {}", e))?;
            repo.checkout_head(Some(git2::build::CheckoutBuilder::new().safe()))
                .map_err(|e| format!("checkout 分支失败: {}", e))?;

            Ok(GitWriteResult {
                success: true,
                operation: "checkout_branch".to_string(),
                message: format!("已切换到分支 {}", branch),
                branch: Some(branch),
                commit_oid: None,
            })
        }
        _ => Err(format!("不支持的 git write 操作: {}", operation_trimmed)),
    }
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
            create_workspace_snapshot,
            restore_workspace_snapshot,
            run_workspace_command,
            git_write_workspace,
            save_workflow_checkpoint,
            load_latest_workflow_checkpoint,
            fetch_litellm_models,
            post_litellm_chat_completions
        ])
        .run(tauri::generate_context!())
        .expect("error while running cofree tauri application");
}

fn main() {
    run();
}
