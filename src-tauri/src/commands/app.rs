use crate::application;
use crate::domain::{AppError, AppHealth, RecoveryResult, WorkspaceInfo};
use crate::infrastructure::cofree_home_dir;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

/// 审计日志在被滚动到 .1 备份前的最大字节数。
/// 单条审计记录通常 < 4KB，10MB 大约可容纳几千条；用户可定期清理或导出。
const ACTION_AUDIT_LOG_MAX_BYTES: u64 = 10 * 1024 * 1024;

/// Process-wide lock around the audit-log append flow. Tauri dispatches
/// commands on a thread pool, so two `recordSensitiveActionAudit` calls can
/// land in `append_action_audit_log` simultaneously. Without this lock the
/// metadata-size check, rotation rename, and append-open would race against
/// each other (TOCTOU on size, lost rotations when two threads both decide to
/// rotate). Same pattern as `secure_store.rs` / `http.rs`.
fn audit_log_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[tauri::command]
pub fn healthcheck() -> AppHealth {
    AppHealth {
        status: "ok".to_string(),
        milestone: "1".to_string(),
    }
}

#[tauri::command]
pub fn select_workspace_folder() -> Result<String, String> {
    rfd::FileDialog::new()
        .pick_folder()
        .ok_or_else(|| "No folder selected".to_string())
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn validate_git_repo(path: String) -> Result<bool, String> {
    let repo_path = Path::new(&path);
    if !repo_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    Ok(true)
}

#[tauri::command]
pub fn get_workspace_info(path: String) -> Result<WorkspaceInfo, String> {
    let repo_path = Path::new(&path);
    if !repo_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    let (git_branch, repo_name) = match git2::Repository::open(&path) {
        Ok(repo) => {
            let branch = repo
                .head()
                .ok()
                .and_then(|head| head.shorthand().map(|s| s.to_string()));
            let name = repo_path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string());
            (branch, name)
        }
        Err(_) => {
            let name = repo_path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string());
            (None, name)
        }
    };

    Ok(WorkspaceInfo {
        path: path.clone(),
        git_branch,
        repo_name,
    })
}

#[tauri::command]
pub fn save_workflow_checkpoint(
    session_id: String,
    message_id: String,
    workflow_state: String,
    payload_json: String,
) -> Result<crate::domain::CheckpointRecord, AppError> {
    application::save_workflow_checkpoint(session_id, message_id, workflow_state, payload_json)
}

#[tauri::command]
pub fn load_latest_workflow_checkpoint(session_id: String) -> Result<RecoveryResult, AppError> {
    application::load_latest_workflow_checkpoint(session_id)
}

#[tauri::command]
pub fn delete_workflow_checkpoints(session_prefix: String) -> Result<u64, AppError> {
    application::delete_workflow_checkpoints(session_prefix)
}

/// Append a single audit record (JSON object, encoded as a string by the
/// frontend) to `~/.cofree/audit.jsonl`. The frontend's localStorage cache is
/// kept as a UI mirror but the file is the source of truth — it survives
/// browser-data clears, app reinstalls, and the localStorage 200-record cap.
///
/// The record is parsed once for validation, then re-serialized on a single
/// line so the file remains valid JSONL even if the caller passed pretty-
/// printed input.
///
/// When the file exceeds `ACTION_AUDIT_LOG_MAX_BYTES` it is rotated to
/// `audit.jsonl.1` (overwriting any prior backup) before the new line is
/// appended. We keep only one rotation generation — callers concerned about
/// long-term retention should export to JSON/CSV via the existing settings UI.
#[tauri::command]
pub fn append_action_audit_log(record_json: String) -> Result<(), String> {
    let parsed: serde_json::Value = serde_json::from_str(&record_json)
        .map_err(|e| format!("invalid audit record json: {}", e))?;
    if !parsed.is_object() {
        return Err("audit record must be a JSON object".to_string());
    }
    let line =
        serde_json::to_string(&parsed).map_err(|e| format!("serialize audit record: {}", e))?;

    let dir = cofree_home_dir().map_err(|e| e.to_string())?;

    // Serialize the size-check → rotate → open → write window across all
    // concurrent Tauri command invocations in this process. Acquired only
    // once we have valid input to log; cheap parsing/path resolution above
    // stays outside the critical section.
    let _guard = audit_log_lock()
        .lock()
        .map_err(|_| "audit log lock poisoned".to_string())?;

    fs::create_dir_all(&dir)
        .map_err(|e| format!("create cofree home dir failed: {}", e))?;
    let path = dir.join("audit.jsonl");

    // Rotate if oversized. We only keep one generation of backup; older
    // history must be exported via the audit UI.
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > ACTION_AUDIT_LOG_MAX_BYTES {
            let backup = dir.join("audit.jsonl.1");
            let _ = fs::remove_file(&backup);
            let _ = fs::rename(&path, &backup);
        }
    }

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open audit log failed: {}", e))?;
    // Single write_all for the JSON record + newline. Two separate writes
    // can interleave with another writer's bytes when O_APPEND is used (each
    // write() syscall atomically seeks-and-writes, but the boundary between
    // two writes is a window for someone else's record to land), producing
    // malformed JSONL. One buffer = one syscall for records ≤ PIPE_BUF (4 KB
    // on Linux/macOS) which is well above our typical record size.
    let mut buf = line.into_bytes();
    buf.push(b'\n');
    file.write_all(&buf)
        .map_err(|e| format!("write audit log failed: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn save_file_dialog(file_name: String, content: String) -> Result<String, String> {
    let path = rfd::FileDialog::new()
        .set_file_name(&file_name)
        .save_file()
        .ok_or_else(|| "用户取消了保存".to_string())?;

    fs::write(&path, content.as_bytes()).map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}
