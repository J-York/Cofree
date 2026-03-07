use crate::application;
use crate::domain::{AppError, AppHealth, RecoveryResult, WorkspaceInfo};
use std::fs;
use std::path::Path;

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
pub fn save_file_dialog(file_name: String, content: String) -> Result<String, String> {
    let path = rfd::FileDialog::new()
        .set_file_name(&file_name)
        .save_file()
        .ok_or_else(|| "用户取消了保存".to_string())?;

    fs::write(&path, content.as_bytes()).map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}
