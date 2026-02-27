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

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::fs;

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
    
    let workspace = PathBuf::from(workspace_path);
    let target = workspace.join(relative_path);
    
    // Canonicalize both paths for comparison
    let workspace_canonical = workspace
        .canonicalize()
        .map_err(|e| format!("Invalid workspace path: {}", e))?;
    
    let target_canonical = target
        .canonicalize()
        .map_err(|e| format!("Invalid target path: {}", e))?;
    
    // Ensure target is within workspace
    if !target_canonical.starts_with(&workspace_canonical) {
        return Err("Path escapes workspace boundary".to_string());
    }
    
    Ok(target_canonical)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![healthcheck, select_workspace_folder, validate_git_repo, get_workspace_info, read_workspace_file, list_workspace_files, git_status_workspace, git_diff_workspace])
        .run(tauri::generate_context!())
        .expect("error while running cofree tauri application");
}

fn main() {
    run();
}
