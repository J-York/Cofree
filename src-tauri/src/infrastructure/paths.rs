//! 路径、目录与标识符生成相关基础设施。

use crate::domain::AppError;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 生成带时间戳和自增序号的唯一 ID（用于 checkpoint / snapshot）。
pub fn generate_id(prefix: &str) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let counter = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}-{}", prefix, nanos, counter)
}

pub fn cofree_home_dir() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir().ok_or_else(|| AppError::config("无法获取用户主目录"))?;
    Ok(home.join(".cofree"))
}

pub fn sqlite_db_path() -> Result<PathBuf, AppError> {
    Ok(cofree_home_dir()?.join("checkpoints.db"))
}

pub fn snapshots_root_dir() -> Result<PathBuf, AppError> {
    Ok(cofree_home_dir()?.join("snapshots"))
}

pub fn canonicalize_workspace_root(workspace_path: &str) -> Result<PathBuf, AppError> {
    let workspace = PathBuf::from(workspace_path);
    if !workspace.exists() {
        return Err(AppError::workspace(format!(
            "Workspace path does not exist: {}",
            workspace_path
        )));
    }
    if !workspace.is_dir() {
        return Err(AppError::workspace(format!(
            "Workspace path is not a directory: {}",
            workspace_path
        )));
    }
    workspace
        .canonicalize()
        .map_err(|e| AppError::workspace(format!("Invalid workspace path: {}", e)))
}

pub fn now_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs().to_string(),
        Err(_) => "0".to_string(),
    }
}

/// 校验相对路径在工作区内，返回规范化的绝对路径。
pub fn validate_workspace_path(
    workspace_path: &str,
    relative_path: &str,
) -> Result<PathBuf, AppError> {
    if Path::new(relative_path).is_absolute() {
        return Err(AppError::validation("Absolute paths not allowed"));
    }
    if relative_path.contains("..") {
        return Err(AppError::validation("Path traversal (..) not allowed"));
    }
    let workspace = canonicalize_workspace_root(workspace_path)?;
    let target = workspace.join(relative_path);
    let target_canonical = target
        .canonicalize()
        .map_err(|e| AppError::file(format!("Invalid target path: {}", e)))?;
    if !target_canonical.starts_with(&workspace) {
        return Err(AppError::validation("Path escapes workspace boundary"));
    }
    Ok(target_canonical)
}
