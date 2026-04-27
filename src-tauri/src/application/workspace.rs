use crate::config;
use crate::domain::{
    AppError, CommandExecutionResult, FileEntry, FileStructure, GitStatus, GlobEntry, GrepMatch,
    GrepResult, PatchApplyResult, ReadFileResult, ShellCommandEvent, ShellCommandStartResult,
    SnapshotFileRecord, SnapshotManifest, SnapshotResult, SymbolInfo, WorkspaceStructureResult,
};
use crate::infrastructure::{
    canonicalize_workspace_root, generate_id, snapshots_root_dir, validate_workspace_path,
};
use glob::glob as glob_match;
use regex::Regex;
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct ShellJobStore {
    jobs: Arc<Mutex<HashMap<String, Arc<ShellJobHandle>>>>,
    /// Retains the final result of completed/cancelled jobs so that
    /// check_shell_job can still report exit_code / stdout / stderr after the
    /// active entry is removed.  Entries are written just before removal from
    /// `jobs` and kept until the store is dropped.
    completed: Arc<Mutex<HashMap<String, CompletedJobResult>>>,
}

struct ShellJobHandle {
    child: Mutex<Option<Child>>,
    cancel_requested: AtomicBool,
}

/// Snapshot of a completed shell job retained for polling by check_shell_job.
#[derive(Clone, serde::Serialize)]
pub struct CompletedJobResult {
    pub success: bool,
    pub exit_code: i32,
    pub timed_out: bool,
    pub cancelled: bool,
    pub stdout: String,
    pub stderr: String,
}

struct ShellOutputCapture {
    preview: String,
    total_bytes: usize,
    truncated: bool,
    limit_bytes: Option<usize>,
}

impl ShellOutputCapture {
    fn new(limit_bytes: Option<usize>) -> Self {
        Self {
            preview: String::new(),
            total_bytes: 0,
            truncated: false,
            limit_bytes,
        }
    }

    fn push_chunk(&mut self, chunk: &str) {
        self.total_bytes = self.total_bytes.saturating_add(chunk.as_bytes().len());
        self.preview.push_str(chunk);
        if let Some(limit_bytes) = self.limit_bytes {
            if self.preview.len() > limit_bytes {
                self.truncated = true;
                trim_string_to_tail(&mut self.preview, limit_bytes);
            }
        }
    }

    fn snapshot(&self) -> (String, u64, bool, Option<u64>) {
        (
            self.preview.clone(),
            self.total_bytes as u64,
            self.truncated,
            self.limit_bytes.map(|value| value as u64),
        )
    }
}

fn clamp_shell_output_limit(max_output_bytes: Option<u64>) -> Option<usize> {
    max_output_bytes
        .and_then(|value| usize::try_from(value).ok())
        .map(|value| value.clamp(1024, 1024 * 1024))
}

/// Keep the longest valid UTF-8 suffix whose byte length is <= `limit_bytes`.
///
/// If the cut point lands in the middle of a multi-byte code point, the result
/// may be shorter than `limit_bytes`; that is intentional, because any longer
/// suffix would exceed the byte cap once the full code point is included.
fn trim_string_to_tail(value: &mut String, limit_bytes: usize) {
    if value.len() <= limit_bytes {
        return;
    }
    let mut start = value.len().saturating_sub(limit_bytes);
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    value.drain(..start);
}

fn append_command_result_stderr(payload: &mut CommandExecutionResult, message: &str) {
    if message.trim().is_empty() {
        return;
    }
    let mut suffix = String::new();
    if !payload.stderr.ends_with('\n') && !payload.stderr.is_empty() {
        suffix.push('\n');
    }
    suffix.push_str(message);
    payload.stderr_total_bytes = payload
        .stderr_total_bytes
        .saturating_add(suffix.as_bytes().len() as u64);
    payload.stderr.push_str(&suffix);
    if let Some(limit_bytes) = payload
        .output_limit_bytes
        .and_then(|value| usize::try_from(value).ok())
    {
        if payload.stderr.len() > limit_bytes {
            payload.stderr_truncated = true;
            trim_string_to_tail(&mut payload.stderr, limit_bytes);
        }
    }
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

struct TempDirCleanup(PathBuf);

impl TempDirCleanup {
    fn new(path: PathBuf) -> Self {
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDirCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn rewrite_edit_patch_paths(raw_patch: &str, relative_path: &str) -> String {
    let mut rewritten = Vec::new();
    for line in raw_patch.lines() {
        if line.starts_with("diff --git ") {
            rewritten.push(format!(
                "diff --git a/{} b/{}",
                relative_path, relative_path
            ));
        } else if line.starts_with("--- ") {
            rewritten.push(format!("--- a/{}", relative_path));
        } else if line.starts_with("+++ ") {
            rewritten.push(format!("+++ b/{}", relative_path));
        } else {
            rewritten.push(line.to_string());
        }
    }
    let mut patch = rewritten.join("\n");
    if raw_patch.ends_with('\n') {
        patch.push('\n');
    }
    patch
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

fn is_ignored_dir(name: &str) -> bool {
    config::DEFAULT_IGNORED_DIRS.contains(&name)
}

fn normalize_rel_path_for_match(path: &str) -> String {
    path.replace('\\', "/")
        .trim_start_matches("./")
        .trim_matches('/')
        .to_string()
}

fn normalize_ignore_pattern(pattern: &str) -> Option<String> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() || trimmed.starts_with('!') {
        return None;
    }
    let normalized = trimmed.replace('\\', "/");
    let normalized = normalized.trim_start_matches("./");
    if normalized.ends_with('/') {
        return Some(format!("{}**", normalized));
    }
    Some(normalized.to_string())
}

fn should_ignore_by_patterns(rel_path: &str, patterns: &Option<Vec<String>>) -> bool {
    let Some(raw_patterns) = patterns.as_ref() else {
        return false;
    };
    let normalized_path = normalize_rel_path_for_match(rel_path);
    if normalized_path.is_empty() {
        return false;
    }
    for raw in raw_patterns {
        let Some(pat) = normalize_ignore_pattern(raw) else {
            continue;
        };
        let target = if pat.contains('/') {
            normalized_path.as_str()
        } else {
            Path::new(&normalized_path)
                .file_name()
                .and_then(|v| v.to_str())
                .unwrap_or(&normalized_path)
        };
        if let Ok(glob_pat) = glob::Pattern::new(&pat) {
            if glob_pat.matches(target) {
                return true;
            }
        }
    }
    false
}

fn should_ignore_rel_path(rel_path: &str, patterns: &Option<Vec<String>>) -> bool {
    let normalized = normalize_rel_path_for_match(rel_path);
    if normalized
        .split('/')
        .any(|segment| !segment.is_empty() && is_ignored_dir(segment))
    {
        return true;
    }
    should_ignore_by_patterns(&normalized, patterns)
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
            if name.starts_with('.') && path != root && is_ignored_dir(&name) {
                continue;
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

fn to_workspace_relative_string(workspace: &Path, path: &Path) -> String {
    path.strip_prefix(workspace)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
        .replace('\\', "/")
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

fn validate_shell_safety(shell: &str) -> Result<(), String> {
    let lowered = shell.to_lowercase();
    if config::SHELL_BLOCKED_PATTERNS
        .iter()
        .any(|pattern| lowered.contains(pattern))
    {
        return Err("命令命中高风险关键字（系统级破坏性命令），已拒绝执行".to_string());
    }
    Ok(())
}

fn apply_patch_internal(
    workspace_path: String,
    patch: String,
    check_only: bool,
) -> Result<PatchApplyResult, String> {
    let workspace = canonicalize_workspace_root(&workspace_path).map_err(|e| e.to_string())?;
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
pub fn read_workspace_file(
    workspace_path: String,
    relative_path: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
    ignore_patterns: Option<Vec<String>>,
) -> Result<ReadFileResult, AppError> {
    let file_path = validate_workspace_path(&workspace_path, &relative_path)?;
    let rel = normalize_rel_path_for_match(&relative_path);
    if should_ignore_rel_path(&rel, &ignore_patterns) {
        return Err(AppError::file("Path is ignored by project config"));
    }
    if !file_path.is_file() {
        return Err(AppError::file("Path is not a file"));
    }
    let content = fs::read_to_string(&file_path)
        .map_err(|e| AppError::file(format!("Failed to read file: {}", e)))?;
    let segments: Vec<&str> = content.split_inclusive('\n').collect();
    let total_lines = if content.is_empty() {
        0
    } else {
        segments.len()
    };
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
        return Err(AppError::validation("start_line 不能大于 end_line"));
    }
    if start > total_lines {
        return Err(AppError::validation(format!(
            "start_line 超出文件范围: {} > {}",
            start, total_lines
        )));
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

#[tauri::command]
pub fn list_workspace_files(
    workspace_path: String,
    relative_path: String,
    ignore_patterns: Option<Vec<String>>,
) -> Result<Vec<FileEntry>, AppError> {
    let dir_path = validate_workspace_path(&workspace_path, &relative_path)?;
    if !dir_path.is_dir() {
        return Err(AppError::file("Path is not a directory"));
    }
    let mut entries = Vec::new();
    let dir_entries = fs::read_dir(&dir_path)
        .map_err(|e| AppError::file(format!("Failed to read directory: {}", e)))?;
    for entry in dir_entries {
        let entry = entry.map_err(|e| AppError::file(format!("Failed to read entry: {}", e)))?;
        let path = entry.path();
        if !path
            .canonicalize()
            .ok()
            .and_then(|p| dir_path.canonicalize().ok().map(|d| p.starts_with(d)))
            .unwrap_or(false)
        {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|e| AppError::file(format!("Failed to get metadata: {}", e)))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let rel_dir = normalize_rel_path_for_match(&relative_path);
        let entry_rel = if rel_dir.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", rel_dir, name)
        };
        if should_ignore_rel_path(&entry_rel, &ignore_patterns) {
            continue;
        }
        entries.push(FileEntry {
            name,
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            modified,
        });
    }
    Ok(entries)
}

#[tauri::command]
pub fn git_status_workspace(workspace_path: String) -> Result<GitStatus, String> {
    let status_obj = GitStatus {
        modified: Vec::new(),
        added: Vec::new(),
        deleted: Vec::new(),
        untracked: Vec::new(),
    };
    let repo = match git2::Repository::open(&workspace_path) {
        Ok(repo) => repo,
        Err(_) => return Ok(status_obj),
    };
    let mut result = status_obj;
    let statuses = repo
        .statuses(None)
        .map_err(|e| format!("Failed to get git status: {}", e))?;
    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let status = entry.status();
        if status.contains(git2::Status::WT_MODIFIED)
            || status.contains(git2::Status::INDEX_MODIFIED)
        {
            result.modified.push(path);
        } else if status.contains(git2::Status::WT_NEW) || status.contains(git2::Status::INDEX_NEW)
        {
            result.added.push(path);
        } else if status.contains(git2::Status::WT_DELETED)
            || status.contains(git2::Status::INDEX_DELETED)
        {
            result.deleted.push(path);
        } else if status.contains(git2::Status::IGNORED) {
        } else if !status.is_empty() {
            result.untracked.push(path);
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn git_diff_workspace(
    workspace_path: String,
    file_path: Option<String>,
) -> Result<String, AppError> {
    let workspace = canonicalize_workspace_root(&workspace_path)?;
    if git2::Repository::open(&workspace).is_err() {
        return Ok(String::new());
    }
    let mut args = vec!["diff", "--no-ext-diff"];
    if git_has_head(&workspace) {
        args.push("HEAD");
    }
    let sanitized_file = if let Some(raw_file) = file_path {
        Some(
            sanitize_relative_path(&raw_file)
                .ok_or_else(|| AppError::validation("file_path 非法"))?
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
        .map_err(|e| AppError::git(format!("执行 git diff 失败: {}", e)))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::git(if stderr.is_empty() {
            "执行 git diff 失败".to_string()
        } else {
            stderr
        }));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
pub fn build_workspace_edit_patch(
    relative_path: String,
    before: String,
    after: String,
) -> Result<String, AppError> {
    if before == after {
        return Err(AppError::validation("编辑结果为空，未产生文件变更。"));
    }

    let sanitized = sanitize_relative_path(&relative_path)
        .ok_or_else(|| AppError::validation("relative_path 非法"))?;
    let normalized_relative = sanitized.to_string_lossy().replace('\\', "/");

    let temp_root = TempDirCleanup::new(std::env::temp_dir().join(generate_id("edit-patch")));
    let before_path = temp_root.path().join("__cofree_before__").join(&sanitized);
    let after_path = temp_root.path().join("__cofree_after__").join(&sanitized);

    if let Some(parent) = before_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::file(format!("创建临时 diff 目录失败: {}", e)))?;
    }
    if let Some(parent) = after_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::file(format!("创建临时 diff 目录失败: {}", e)))?;
    }
    fs::write(&before_path, before)
        .map_err(|e| AppError::file(format!("写入旧版本临时文件失败: {}", e)))?;
    fs::write(&after_path, after)
        .map_err(|e| AppError::file(format!("写入新版本临时文件失败: {}", e)))?;

    let output = Command::new("git")
        .args([
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--unified=3",
            "--minimal",
            "--text",
            "--",
        ])
        .arg(&before_path)
        .arg(&after_path)
        .output()
        .map_err(|e| AppError::git(format!("生成编辑 patch 失败: {}", e)))?;

    let status_code = output.status.code().unwrap_or(-1);
    if status_code != 0 && status_code != 1 {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::git(if stderr.is_empty() {
            "生成编辑 patch 失败".to_string()
        } else {
            stderr
        }));
    }

    let raw_patch = String::from_utf8_lossy(&output.stdout).to_string();
    if raw_patch.trim().is_empty() {
        return Err(AppError::validation("编辑结果为空，未产生文件变更。"));
    }

    Ok(rewrite_edit_patch_paths(&raw_patch, &normalized_relative))
}

#[tauri::command]
pub fn grep_workspace_files(
    workspace_path: String,
    pattern: String,
    include_glob: Option<String>,
    max_results: Option<usize>,
    ignore_patterns: Option<Vec<String>>,
) -> Result<GrepResult, AppError> {
    let workspace = canonicalize_workspace_root(&workspace_path)?;
    if pattern.trim().is_empty() {
        return Err(AppError::validation("搜索模式不能为空"));
    }
    let regex = Regex::new(&pattern)
        .map_err(|e| AppError::validation(format!("无效的正则表达式: {}", e)))?;
    let limit = max_results
        .unwrap_or(config::GREP_DEFAULT_MAX_RESULTS)
        .min(config::GREP_ABSOLUTE_MAX_RESULTS);
    let all_files = walk_workspace_files(&workspace, config::GREP_MAX_FILES);
    let include_pattern = include_glob.as_deref().unwrap_or("");
    let glob_filter: Option<glob::Pattern> = if !include_pattern.is_empty() {
        Some(
            glob::Pattern::new(include_pattern)
                .map_err(|e| AppError::validation(format!("无效的 glob 模式: {}", e)))?,
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
        let rel = to_workspace_relative_string(&workspace, file_path);
        if should_ignore_rel_path(&rel, &ignore_patterns) {
            continue;
        }
        if let Some(ref gf) = glob_filter {
            let file_name = file_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if !gf.matches(&file_name) {
                let rel = to_workspace_relative_string(&workspace, file_path);
                if !gf.matches(&rel) {
                    continue;
                }
            }
        }
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
                let relative = to_workspace_relative_string(&workspace, file_path);
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
    Ok(GrepResult { matches, truncated })
}

#[tauri::command]
pub fn glob_workspace_files(
    workspace_path: String,
    pattern: String,
    max_results: Option<usize>,
    ignore_patterns: Option<Vec<String>>,
) -> Result<Vec<GlobEntry>, AppError> {
    let workspace = canonicalize_workspace_root(&workspace_path)?;
    if pattern.trim().is_empty() {
        return Err(AppError::validation("glob 模式不能为空"));
    }
    let limit = max_results
        .unwrap_or(config::GLOB_DEFAULT_MAX_RESULTS)
        .min(config::GLOB_ABSOLUTE_MAX_RESULTS);
    let full_pattern = workspace.join(pattern.trim()).to_string_lossy().to_string();
    let mut entries = Vec::new();
    for entry in glob_match(&full_pattern)
        .map_err(|e| AppError::validation(format!("无效的 glob 模式: {}", e)))?
    {
        if entries.len() >= limit {
            break;
        }
        let path = match entry {
            Ok(p) => p,
            Err(_) => continue,
        };
        let relative = to_workspace_relative_string(&workspace, &path);
        if should_ignore_rel_path(&relative, &ignore_patterns) {
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
    entries.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(entries)
}

#[tauri::command]
pub fn apply_workspace_patch(
    workspace_path: String,
    patch: String,
) -> Result<PatchApplyResult, String> {
    apply_patch_internal(workspace_path, patch, false)
}

#[tauri::command]
pub fn check_workspace_patch(
    workspace_path: String,
    patch: String,
) -> Result<PatchApplyResult, String> {
    apply_patch_internal(workspace_path, patch, true)
}

#[tauri::command]
pub fn create_workspace_snapshot(
    workspace_path: String,
    patch: Option<String>,
) -> Result<SnapshotResult, String> {
    let workspace = canonicalize_workspace_root(&workspace_path).map_err(|e| e.to_string())?;
    let snapshots_root = snapshots_root_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&snapshots_root).map_err(|e| format!("创建 snapshots 根目录失败: {}", e))?;
    let files = patch.as_deref().map(parse_patch_files).unwrap_or_default();
    let snapshot_id = generate_id("snapshot");
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
pub fn restore_workspace_snapshot(
    workspace_path: String,
    snapshot_id: Option<String>,
) -> Result<PatchApplyResult, String> {
    let workspace = canonicalize_workspace_root(&workspace_path).map_err(|e| e.to_string())?;
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
    let snapshot_path = snapshots_root_dir()
        .map_err(|e| e.to_string())?
        .join(snapshot_id_raw.trim());
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
pub fn run_shell_command(
    workspace_path: String,
    shell: String,
    timeout_ms: Option<u64>,
    max_output_bytes: Option<u64>,
) -> Result<CommandExecutionResult, String> {
    let workspace = canonicalize_workspace_root(&workspace_path).map_err(|e| e.to_string())?;
    let shell_trimmed = shell.trim().to_string();
    if shell_trimmed.is_empty() {
        return Err("命令不能为空".to_string());
    }
    validate_shell_safety(&shell_trimmed)?;
    let max_timeout = timeout_ms
        .unwrap_or(config::SHELL_TIMEOUT_DEFAULT_MS)
        .clamp(config::SHELL_TIMEOUT_MIN_MS, config::SHELL_TIMEOUT_MAX_MS);
    let timeout = Some(Duration::from_millis(max_timeout));
    let child = spawn_shell_child(&workspace, &shell_trimmed)?;
    collect_shell_command_result(
        child,
        &shell_trimmed,
        timeout,
        None,
        None,
        clamp_shell_output_limit(max_output_bytes),
    )
}

#[tauri::command]
pub fn start_shell_command(
    app: AppHandle,
    jobs: State<'_, ShellJobStore>,
    workspace_path: String,
    shell: String,
    timeout_ms: Option<u64>,
    detached: Option<bool>,
    max_output_bytes: Option<u64>,
) -> Result<ShellCommandStartResult, String> {
    let workspace = canonicalize_workspace_root(&workspace_path).map_err(|e| e.to_string())?;
    let shell_trimmed = shell.trim().to_string();
    if shell_trimmed.is_empty() {
        return Err("命令不能为空".to_string());
    }
    validate_shell_safety(&shell_trimmed)?;
    let timeout = if detached.unwrap_or(false) {
        None
    } else {
        let max_timeout = timeout_ms
            .unwrap_or(config::SHELL_TIMEOUT_DEFAULT_MS)
            .clamp(config::SHELL_TIMEOUT_MIN_MS, config::SHELL_TIMEOUT_MAX_MS);
        Some(Duration::from_millis(max_timeout))
    };
    let child = spawn_shell_child(&workspace, &shell_trimmed)?;
    let output_limit = clamp_shell_output_limit(max_output_bytes);
    let job_id = generate_id("shelljob");
    let job_handle = Arc::new(ShellJobHandle {
        child: Mutex::new(Some(child)),
        cancel_requested: AtomicBool::new(false),
    });

    jobs.jobs
        .lock()
        .map_err(|_| "shell job store lock poisoned".to_string())?
        .insert(job_id.clone(), Arc::clone(&job_handle));

    let app_handle = app.clone();
    let job_id_for_thread = job_id.clone();
    let command_for_thread = shell_trimmed.clone();
    let jobs_for_thread = Arc::clone(&jobs.inner().jobs);
    let completed_for_thread = Arc::clone(&jobs.inner().completed);
    thread::spawn(move || {
        emit_shell_command_event(
            &app_handle,
            ShellCommandEvent {
                job_id: job_id_for_thread.clone(),
                event_type: "started".to_string(),
                command: command_for_thread.clone(),
                stream: None,
                chunk: None,
                success: None,
                timed_out: None,
                cancelled: None,
                status: None,
                stdout: None,
                stderr: None,
                stdout_truncated: None,
                stderr_truncated: None,
                stdout_total_bytes: None,
                stderr_total_bytes: None,
                output_limit_bytes: output_limit.map(|value| value as u64),
                prompt_text: None,
            },
        );

        let result = collect_shell_job_result(
            Arc::clone(&job_handle),
            &command_for_thread,
            timeout,
            Some(app_handle.clone()),
            Some(job_id_for_thread.clone()),
            output_limit,
        );

        let cancelled = job_handle.cancel_requested.load(Ordering::SeqCst);
        let final_result = match result {
            Ok(mut payload) => {
                if cancelled && !payload.success {
                    append_command_result_stderr(&mut payload, "Command cancelled");
                }
                payload
            }
            Err(error) => CommandExecutionResult {
                success: false,
                command: command_for_thread.clone(),
                timed_out: false,
                status: -1,
                stdout: String::new(),
                stderr_total_bytes: error.as_bytes().len() as u64,
                stderr: error,
                stdout_truncated: false,
                stderr_truncated: false,
                stdout_total_bytes: 0,
                output_limit_bytes: output_limit.map(|value| value as u64),
            },
        };

        emit_shell_command_event(
            &app_handle,
            ShellCommandEvent {
                job_id: job_id_for_thread.clone(),
                event_type: "completed".to_string(),
                command: command_for_thread,
                stream: None,
                chunk: None,
                success: Some(final_result.success),
                timed_out: Some(final_result.timed_out),
                cancelled: Some(cancelled),
                status: Some(final_result.status),
                stdout: Some(final_result.stdout.clone()),
                stderr: Some(final_result.stderr.clone()),
                stdout_truncated: Some(final_result.stdout_truncated),
                stderr_truncated: Some(final_result.stderr_truncated),
                stdout_total_bytes: Some(final_result.stdout_total_bytes),
                stderr_total_bytes: Some(final_result.stderr_total_bytes),
                output_limit_bytes: final_result.output_limit_bytes,
                prompt_text: None,
            },
        );

        // Store the completed result BEFORE removing from the active registry
        // so that check_shell_job can retrieve it even if polled immediately
        // after the completion event.
        let completed_entry = CompletedJobResult {
            success: final_result.success,
            exit_code: final_result.status,
            timed_out: final_result.timed_out,
            cancelled,
            stdout: final_result.stdout,
            stderr: final_result.stderr,
        };
        if let Ok(mut guard) = completed_for_thread.lock() {
            guard.insert(job_id_for_thread.clone(), completed_entry);
        }

        if let Ok(mut guard) = jobs_for_thread.lock() {
            guard.remove(&job_id_for_thread);
        }
    });

    Ok(ShellCommandStartResult {
        job_id,
        command: shell_trimmed,
    })
}

#[tauri::command]
pub fn open_system_terminal(workspace_path: String) -> Result<(), String> {
    let trimmed = workspace_path.trim();
    if trimmed.is_empty() {
        return Err("workspace path is empty".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_dir() {
        return Err(format!("workspace path is not a directory: {}", trimmed));
    }
    let path_str = path.to_string_lossy().to_string();

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-a", "Terminal", &path_str])
            .spawn()
            .map_err(|e| format!("failed to launch Terminal: {}", e))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        if Command::new("wt.exe")
            .args(["-d", &path_str])
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
        Command::new("cmd")
            .args(["/C", "start", "", "cmd", "/K", "cd", "/D", &path_str])
            .spawn()
            .map_err(|e| format!("failed to launch cmd: {}", e))?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        let candidates: &[(&str, &[&str], bool)] = &[
            ("x-terminal-emulator", &[], true),
            ("gnome-terminal", &["--working-directory"], false),
            ("konsole", &["--workdir"], false),
            ("xfce4-terminal", &["--working-directory"], false),
            ("alacritty", &["--working-directory"], false),
            ("kitty", &["-d"], false),
            ("xterm", &[], true),
        ];
        for (program, flag_args, use_cwd) in candidates {
            let mut cmd = Command::new(program);
            if !flag_args.is_empty() {
                for flag in *flag_args {
                    cmd.arg(flag);
                }
                cmd.arg(&path_str);
            }
            if *use_cwd {
                cmd.current_dir(&path);
            }
            if cmd.spawn().is_ok() {
                return Ok(());
            }
        }
        return Err("no supported terminal emulator found on PATH".to_string());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("opening system terminal is not supported on this platform".to_string())
    }
}

#[tauri::command]
pub fn cancel_shell_command(
    jobs: State<'_, ShellJobStore>,
    job_id: String,
) -> Result<bool, String> {
    let job = {
        let guard = jobs
            .jobs
            .lock()
            .map_err(|_| "shell job store lock poisoned".to_string())?;
        guard.get(job_id.trim()).cloned()
    };

    let Some(job) = job else {
        return Ok(false);
    };

    job.cancel_requested.store(true, Ordering::SeqCst);
    let mut child_guard = job
        .child
        .lock()
        .map_err(|_| "shell job lock poisoned".to_string())?;
    if let Some(child) = child_guard.as_mut() {
        child.kill().map_err(|e| format!("取消命令失败: {}", e))?;
        return Ok(true);
    }

    Ok(false)
}

#[tauri::command]
pub fn check_shell_job(
    jobs: State<'_, ShellJobStore>,
    job_id: String,
) -> Result<serde_json::Value, String> {
    let job_id_trimmed = job_id.trim().to_string();

    // Check active jobs first.
    let active_job = {
        let guard = jobs
            .jobs
            .lock()
            .map_err(|_| "shell job store lock poisoned".to_string())?;
        guard.get(&job_id_trimmed).cloned()
    };

    if let Some(job) = active_job {
        // Try to check exit status without blocking
        let running = {
            let mut guard = job
                .child
                .lock()
                .map_err(|_| "shell job lock poisoned".to_string())?;
            match guard.as_mut() {
                None => false,
                Some(child) => match child.try_wait() {
                    Ok(Some(_)) => false, // exited
                    Ok(None) => true,     // still running
                    Err(_) => false,
                },
            }
        };

        return Ok(serde_json::json!({
            "running": running,
            "found": true,
            "completed": false,
            "cancelled": job.cancel_requested.load(Ordering::SeqCst),
        }));
    }

    // Not in active registry — check the completed results store.
    let completed = {
        let guard = jobs
            .completed
            .lock()
            .map_err(|_| "completed job store lock poisoned".to_string())?;
        guard.get(&job_id_trimmed).cloned()
    };

    if let Some(result) = completed {
        return Ok(serde_json::json!({
            "running": false,
            "found": true,
            "completed": true,
            "cancelled": result.cancelled,
            "success": result.success,
            "exit_code": result.exit_code,
            "timed_out": result.timed_out,
            "stdout": result.stdout,
            "stderr": result.stderr,
        }));
    }

    // Job not found in either store — never existed or predates this session.
    Ok(serde_json::json!({
        "running": false,
        "found": false,
        "completed": false,
    }))
}

fn spawn_shell_child(workspace: &Path, shell_trimmed: &str) -> Result<Child, String> {
    if cfg!(target_os = "windows") {
        Command::new("powershell")
            .args(["-NoProfile", "-Command", shell_trimmed])
            .current_dir(workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("CI", "true")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("PAGER", "cat")
            .env("CLICOLOR", "0")
            .spawn()
            .map_err(|e| format!("启动 powershell 失败: {}", e))
    } else {
        Command::new("sh")
            .args(["-c", shell_trimmed])
            .current_dir(workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("CI", "true")
            .env("DEBIAN_FRONTEND", "noninteractive")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("PAGER", "cat")
            .env("CLICOLOR", "0")
            .spawn()
            .map_err(|e| format!("启动 sh 失败: {}", e))
    }
}

fn emit_shell_command_event(app: &AppHandle, event: ShellCommandEvent) {
    let _ = app.emit("shell-command-event", event);
}

fn spawn_pipe_reader<R: Read + Send + 'static>(
    mut reader: R,
    sink: Arc<Mutex<ShellOutputCapture>>,
    app: Option<AppHandle>,
    job_id: Option<String>,
    command: String,
    stream: &'static str,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    if let Ok(mut output) = sink.lock() {
                        output.push_chunk(&chunk);
                    }
                    if let (Some(app_handle), Some(job_id_value)) = (&app, &job_id) {
                        emit_shell_command_event(
                            app_handle,
                            ShellCommandEvent {
                                job_id: job_id_value.clone(),
                                event_type: "output".to_string(),
                                command: command.clone(),
                                stream: Some(stream.to_string()),
                                chunk: Some(chunk.clone()),
                                success: None,
                                timed_out: None,
                                cancelled: None,
                                status: None,
                                stdout: None,
                                stderr: None,
                                stdout_truncated: None,
                                stderr_truncated: None,
                                stdout_total_bytes: None,
                                stderr_total_bytes: None,
                                output_limit_bytes: None,
                                prompt_text: None,
                            },
                        );

                        // Detect interactive prompts and emit a warning event.
                        // Since stdin is /dev/null the process will get EOF and
                        // likely fail, but the event helps the Agent understand
                        // why and retry with non-interactive flags (--yes, -y).
                        let chunk_lower = chunk.to_lowercase();
                        if let Some(pattern) = config::INTERACTIVE_PROMPT_PATTERNS
                            .iter()
                            .find(|&&p| chunk_lower.contains(p))
                        {
                            emit_shell_command_event(
                                app_handle,
                                ShellCommandEvent {
                                    job_id: job_id_value.clone(),
                                    event_type: "waiting_for_input".to_string(),
                                    command: command.clone(),
                                    stream: Some(stream.to_string()),
                                    chunk: None,
                                    success: None,
                                    timed_out: None,
                                    cancelled: None,
                                    status: None,
                                    stdout: None,
                                    stderr: None,
                                    stdout_truncated: None,
                                    stderr_truncated: None,
                                    stdout_total_bytes: None,
                                    stderr_total_bytes: None,
                                    output_limit_bytes: None,
                                    prompt_text: Some(pattern.to_string()),
                                },
                            );
                        }
                    }
                }
                Err(_) => break,
            }
        }
    })
}

fn collect_shell_command_result(
    mut child: Child,
    shell_trimmed: &str,
    timeout: Option<Duration>,
    app: Option<AppHandle>,
    job_id: Option<String>,
    output_limit: Option<usize>,
) -> Result<CommandExecutionResult, String> {
    let stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| "读取 stdout 失败".to_string())?;
    let stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| "读取 stderr 失败".to_string())?;
    let stdout = Arc::new(Mutex::new(ShellOutputCapture::new(output_limit)));
    let stderr = Arc::new(Mutex::new(ShellOutputCapture::new(output_limit)));
    let stdout_handle = spawn_pipe_reader(
        stdout_pipe,
        Arc::clone(&stdout),
        app.clone(),
        job_id.clone(),
        shell_trimmed.to_string(),
        "stdout",
    );
    let stderr_handle = spawn_pipe_reader(
        stderr_pipe,
        Arc::clone(&stderr),
        app,
        job_id,
        shell_trimmed.to_string(),
        "stderr",
    );

    let started_at = Instant::now();
    let mut timed_out = false;
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if timeout.is_some_and(|limit| started_at.elapsed() >= limit) {
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

    let _ = stdout_handle.join();
    let _ = stderr_handle.join();

    let (stdout_value, stdout_total_bytes, stdout_truncated, output_limit_bytes) = stdout
        .lock()
        .map_err(|_| "读取 stdout 失败".to_string())?
        .snapshot();
    let (stderr_value, stderr_total_bytes, stderr_truncated, _) = stderr
        .lock()
        .map_err(|_| "读取 stderr 失败".to_string())?
        .snapshot();

    let mut payload = CommandExecutionResult {
        success: exit_status.success() && !timed_out,
        command: shell_trimmed.to_string(),
        timed_out,
        status: exit_status.code().unwrap_or(-1),
        stdout: stdout_value,
        stderr: stderr_value,
        stdout_truncated,
        stderr_truncated,
        stdout_total_bytes,
        stderr_total_bytes,
        output_limit_bytes,
    };
    if timed_out {
        append_command_result_stderr(&mut payload, "Command timed out");
    }
    Ok(payload)
}

fn collect_shell_job_result(
    job_handle: Arc<ShellJobHandle>,
    shell_trimmed: &str,
    timeout: Option<Duration>,
    app: Option<AppHandle>,
    job_id: Option<String>,
    output_limit: Option<usize>,
) -> Result<CommandExecutionResult, String> {
    let (stdout_pipe, stderr_pipe) = {
        let mut guard = job_handle
            .child
            .lock()
            .map_err(|_| "shell job lock poisoned".to_string())?;
        let child = guard
            .as_mut()
            .ok_or_else(|| "命令进程已不存在".to_string())?;
        let stdout_pipe = child
            .stdout
            .take()
            .ok_or_else(|| "读取 stdout 失败".to_string())?;
        let stderr_pipe = child
            .stderr
            .take()
            .ok_or_else(|| "读取 stderr 失败".to_string())?;
        (stdout_pipe, stderr_pipe)
    };

    let stdout = Arc::new(Mutex::new(ShellOutputCapture::new(output_limit)));
    let stderr = Arc::new(Mutex::new(ShellOutputCapture::new(output_limit)));
    let stdout_handle = spawn_pipe_reader(
        stdout_pipe,
        Arc::clone(&stdout),
        app.clone(),
        job_id.clone(),
        shell_trimmed.to_string(),
        "stdout",
    );
    let stderr_handle = spawn_pipe_reader(
        stderr_pipe,
        Arc::clone(&stderr),
        app,
        job_id,
        shell_trimmed.to_string(),
        "stderr",
    );

    let started_at = Instant::now();
    let mut timed_out = false;
    let exit_status = loop {
        let state = {
            let mut guard = job_handle
                .child
                .lock()
                .map_err(|_| "shell job lock poisoned".to_string())?;
            let child = guard
                .as_mut()
                .ok_or_else(|| "命令进程已不存在".to_string())?;
            match child.try_wait() {
                Ok(Some(status)) => Some(Ok(status)),
                Ok(None) => {
                    if timeout.is_some_and(|limit| started_at.elapsed() >= limit) {
                        timed_out = true;
                        let _ = child.kill();
                        Some(child.wait().map_err(|e| format!("终止超时命令失败: {}", e)))
                    } else {
                        None
                    }
                }
                Err(error) => Some(Err(format!("等待命令执行失败: {}", error))),
            }
        };

        match state {
            Some(Ok(status)) => break status,
            Some(Err(error)) => return Err(error),
            None => thread::sleep(Duration::from_millis(50)),
        }
    };

    if let Ok(mut guard) = job_handle.child.lock() {
        *guard = None;
    }

    let _ = stdout_handle.join();
    let _ = stderr_handle.join();

    let (stdout_value, stdout_total_bytes, stdout_truncated, output_limit_bytes) = stdout
        .lock()
        .map_err(|_| "读取 stdout 失败".to_string())?
        .snapshot();
    let (stderr_value, stderr_total_bytes, stderr_truncated, _) = stderr
        .lock()
        .map_err(|_| "读取 stderr 失败".to_string())?
        .snapshot();

    let mut payload = CommandExecutionResult {
        success: exit_status.success() && !timed_out,
        command: shell_trimmed.to_string(),
        timed_out,
        status: exit_status.code().unwrap_or(-1),
        stdout: stdout_value,
        stderr: stderr_value,
        stdout_truncated,
        stderr_truncated,
        stdout_total_bytes,
        stderr_total_bytes,
        output_limit_bytes,
    };
    if timed_out {
        append_command_result_stderr(&mut payload, "Command timed out");
    }
    Ok(payload)
}

// ---------------------------------------------------------------------------
// Repo-Map: scan workspace structure for symbol extraction
// ---------------------------------------------------------------------------

fn detect_language(ext: &str) -> Option<&'static str> {
    match ext {
        "ts" | "tsx" | "mts" | "cts" => Some("typescript"),
        "js" | "jsx" | "mjs" | "cjs" => Some("javascript"),
        "py" | "pyw" => Some("python"),
        "rs" => Some("rust"),
        "go" => Some("go"),
        "java" => Some("java"),
        "kt" | "kts" => Some("kotlin"),
        "c" | "h" => Some("c"),
        "cpp" | "cxx" | "cc" | "hpp" | "hxx" => Some("cpp"),
        "rb" => Some("ruby"),
        "vue" => Some("vue"),
        "svelte" => Some("svelte"),
        _ => None,
    }
}

fn build_symbol_patterns(language: &str) -> Vec<(&'static str, Regex)> {
    match language {
        "typescript" | "javascript" | "vue" | "svelte" => {
            // Order matters: extract_symbols breaks on the first matching
            // pattern, so list more-specific shapes first. Each pattern emits
            // a kind label that the frontend maps to a single-char prefix
            // (class→c, function→f, constant→v, etc.) — using "export" as the
            // catch-all kind would lose that distinction.
            vec![
                // Class — top-level or any export form (default / abstract).
                (
                    "class",
                    Regex::new(
                        r"^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+(\w+)",
                    )
                    .unwrap(),
                ),
                // Interface — top-level or exported.
                (
                    "interface",
                    Regex::new(r"^(?:export\s+)?interface\s+(\w+)").unwrap(),
                ),
                // Enum — top-level or exported (covers `const enum`).
                (
                    "enum",
                    Regex::new(r"^(?:export\s+)?(?:const\s+)?enum\s+(\w+)").unwrap(),
                ),
                // Type alias — only when exported. Internal type aliases are
                // usually local helpers and add noise to the repo-map.
                (
                    "type",
                    Regex::new(r"^export\s+type\s+(\w+)").unwrap(),
                ),
                // Function — top-level or any export form. Handles
                // default / async / generator (`function*`).
                (
                    "function",
                    Regex::new(
                        r"^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s+(\w+)",
                    )
                    .unwrap(),
                ),
                // Const / let / var — only when exported. Covers
                // `export const Foo = () => ...` arrow-function components
                // (very common in React / TS projects).
                (
                    "constant",
                    Regex::new(
                        r"^export\s+(?:default\s+)?(?:const|let|var)\s+(\w+)",
                    )
                    .unwrap(),
                ),
            ]
        }
        "python" => {
            vec![
                ("def", Regex::new(r"^(?:async\s+)?def\s+(\w+)").unwrap()),
                ("class", Regex::new(r"^class\s+(\w+)").unwrap()),
            ]
        }
        "rust" => {
            vec![
                (
                    "pub",
                    Regex::new(r"^pub\s+(fn|struct|enum|trait|mod|type)\s+(\w+)").unwrap(),
                ),
                ("impl", Regex::new(r"^impl(?:<[^>]*>)?\s+(\w+)").unwrap()),
                (
                    "fn",
                    Regex::new(r"^(?:pub\s*(?:\(crate\)\s*)?)?fn\s+(\w+)").unwrap(),
                ),
            ]
        }
        "go" => {
            vec![
                (
                    "func",
                    Regex::new(r"^func\s+(?:\([^)]*\)\s+)?(\w+)").unwrap(),
                ),
                (
                    "type",
                    Regex::new(r"^type\s+(\w+)\s+(struct|interface)").unwrap(),
                ),
            ]
        }
        "java" | "kotlin" => {
            vec![
                ("class", Regex::new(r"(?:public|private|protected)?\s*(?:static\s+)?(?:abstract\s+)?(?:class|interface|enum)\s+(\w+)").unwrap()),
            ]
        }
        "c" | "cpp" => {
            vec![
                (
                    "function",
                    Regex::new(r"^(?:\w+[\s*]+)+(\w+)\s*\(").unwrap(),
                ),
                ("class", Regex::new(r"^(?:class|struct)\s+(\w+)").unwrap()),
            ]
        }
        "ruby" => {
            vec![
                ("def", Regex::new(r"^\s*def\s+(\w+)").unwrap()),
                ("class", Regex::new(r"^\s*class\s+(\w+)").unwrap()),
                ("module", Regex::new(r"^\s*module\s+(\w+)").unwrap()),
            ]
        }
        _ => vec![],
    }
}

/// Method patterns matched only inside a class body (M4-2). The brace-depth
/// state machine in `extract_symbols` tracks when we're at depth = class +1,
/// so these regex run on member declarations and not at file top level.
///
/// Kept separate from `build_symbol_patterns` so non-brace languages
/// (Python / Ruby) and free-floating-method languages (Go / Rust impl) don't
/// accidentally pick up these patterns at top level.
fn build_method_patterns(language: &str) -> Vec<(&'static str, Regex)> {
    match language {
        "typescript" | "javascript" | "vue" | "svelte" => {
            vec![(
                "method",
                Regex::new(
                    r"^(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\s+)*(\w+)\s*[<(]",
                )
                .unwrap(),
            )]
        }
        "java" | "kotlin" => {
            vec![(
                "method",
                Regex::new(
                    r"^(?:public|private|protected)\s+(?:static\s+)?(?:\w+\s+)(\w+)\s*\(",
                )
                .unwrap(),
            )]
        }
        _ => vec![],
    }
}

/// Names that look like method calls but are language keywords; used to
/// suppress false positives inside class bodies (e.g. `if (cond) {` would
/// otherwise extract a method called `if`).
fn is_method_name_blacklisted(name: &str) -> bool {
    matches!(
        name,
        "if" | "for"
            | "while"
            | "switch"
            | "return"
            | "else"
            | "try"
            | "catch"
            | "do"
            | "throw"
            | "case"
            | "with"
            | "yield"
            | "await"
            | "new"
            | "typeof"
    )
}

fn extract_symbols(content: &str, language: &str) -> Vec<SymbolInfo> {
    let patterns = build_symbol_patterns(language);
    if patterns.is_empty() {
        return Vec::new();
    }
    let method_patterns = build_method_patterns(language);

    let max_symbols = config::REPO_MAP_MAX_SYMBOLS_PER_FILE;
    let max_methods_per_class: usize = 8;
    let sig_max_len = config::REPO_MAP_SIGNATURE_MAX_LEN;
    let mut symbols = Vec::new();

    // M4-2 state machine: track brace depth across lines so member regex
    // only fires inside a class body. `class_body_depth` is the depth that
    // marks the line as a direct member of the most recently opened class.
    // We don't try to handle nested classes — the inner class is treated as
    // top-level once we exit the outer class (rare in real TS code anyway).
    let mut brace_depth: i32 = 0;
    let mut class_body_depth: Option<i32> = None;
    let mut method_count_in_class: usize = 0;

    let make_signature = |line: &str| -> String {
        // M4-3: keep the declaration prefix and drop the body. We look for the
        // first whitespace-followed-by-`{` (body / object-literal open) and
        // cut there. This excludes the `${` inside template literals — `$`
        // isn't whitespace — and the rare `class Foo{` (no space) just falls
        // through to the length cap unchanged.
        let bytes = line.as_bytes();
        let mut cut: Option<usize> = None;
        for i in 1..bytes.len() {
            if bytes[i] == b'{' && (bytes[i - 1] == b' ' || bytes[i - 1] == b'\t') {
                cut = Some(i);
                break;
            }
        }
        let head = match cut {
            Some(i) => line[..i].trim_end(),
            None => line.trim_end(),
        };
        if head.len() > sig_max_len {
            format!("{}...", &head[..sig_max_len])
        } else {
            head.to_string()
        }
    };

    for (line_idx, line) in content.lines().enumerate() {
        if symbols.len() >= max_symbols {
            break;
        }

        let trimmed = line.trim_start();
        let is_skip = trimmed.is_empty()
            || trimmed.starts_with("//")
            || trimmed.starts_with('#')
            || trimmed.starts_with("/*");

        let mut matched_class_this_line = false;

        if !is_skip {
            let in_class = class_body_depth
                .map(|d| brace_depth >= d)
                .unwrap_or(false);

            if !in_class {
                for (kind, regex) in &patterns {
                    if let Some(captures) = regex.captures(trimmed) {
                        let name = captures
                            .get(captures.len() - 1)
                            .or_else(|| captures.get(1))
                            .map(|m| m.as_str().to_string())
                            .unwrap_or_default();
                        if name.is_empty() {
                            continue;
                        }
                        symbols.push(SymbolInfo {
                            kind: kind.to_string(),
                            name,
                            line: line_idx + 1,
                            signature: make_signature(trimmed),
                        });
                        if *kind == "class" {
                            matched_class_this_line = true;
                        }
                        break;
                    }
                }
            } else if !method_patterns.is_empty()
                && brace_depth == class_body_depth.unwrap()
                && method_count_in_class < max_methods_per_class
            {
                for (kind, regex) in &method_patterns {
                    if let Some(captures) = regex.captures(trimmed) {
                        let name = captures
                            .get(captures.len() - 1)
                            .or_else(|| captures.get(1))
                            .map(|m| m.as_str().to_string())
                            .unwrap_or_default();
                        if name.is_empty() || is_method_name_blacklisted(&name) {
                            continue;
                        }
                        symbols.push(SymbolInfo {
                            kind: kind.to_string(),
                            name,
                            line: line_idx + 1,
                            signature: make_signature(trimmed),
                        });
                        method_count_in_class += 1;
                        break;
                    }
                }
            }
        }

        // Update brace depth from this line. Heuristic — we ignore braces
        // inside strings / regex literals / comments; for repo-map purposes
        // this is good enough since real-world code rarely has unbalanced
        // braces in literals.
        let opens = line.chars().filter(|c| *c == '{').count() as i32;
        let closes = line.chars().filter(|c| *c == '}').count() as i32;
        let new_depth = brace_depth + opens - closes;

        // Class body opens after the `class X {` line increases depth.
        if matched_class_this_line && new_depth > brace_depth {
            class_body_depth = Some(new_depth);
            method_count_in_class = 0;
        }
        // Class body closes when depth drops back below the body level.
        if let Some(body_depth) = class_body_depth {
            if new_depth < body_depth {
                class_body_depth = None;
                method_count_in_class = 0;
            }
        }

        brace_depth = new_depth;
    }

    symbols
}

#[tauri::command]
pub fn scan_workspace_structure(
    workspace_path: String,
    ignore_patterns: Option<Vec<String>>,
) -> Result<WorkspaceStructureResult, AppError> {
    let workspace = canonicalize_workspace_root(&workspace_path)?;
    let max_files = config::REPO_MAP_MAX_FILES;
    let max_file_size = config::REPO_MAP_MAX_FILE_SIZE;

    let all_files = walk_workspace_files(&workspace, max_files * 2);
    let total_files = all_files.len();

    let mut file_structures = Vec::new();
    let mut scanned_count = 0;

    for file_path in &all_files {
        if file_structures.len() >= max_files {
            break;
        }

        let rel = to_workspace_relative_string(&workspace, file_path);
        if should_ignore_rel_path(&rel, &ignore_patterns) {
            continue;
        }

        let ext = file_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let language = match detect_language(&ext) {
            Some(lang) => lang,
            None => continue,
        };

        let metadata = match fs::metadata(file_path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if metadata.len() > max_file_size {
            continue;
        }
        if is_likely_binary(file_path) {
            continue;
        }

        let content = match fs::read_to_string(file_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        scanned_count += 1;
        let symbols = extract_symbols(&content, language);
        if symbols.is_empty() {
            continue;
        }

        file_structures.push(FileStructure {
            path: rel,
            language: language.to_string(),
            symbols,
        });
    }

    let truncated = total_files > max_files * 2;
    Ok(WorkspaceStructureResult {
        files: file_structures,
        scanned_count,
        total_files,
        truncated,
    })
}

// ---------------------------------------------------------------------------
// Skill support: absolute file reading & home directory
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn read_absolute_file(path: String) -> Result<String, AppError> {
    let file_path = Path::new(&path);

    // Security: only allow reading regular files, reject symlinks to sensitive locations
    if !file_path.is_absolute() {
        return Err(AppError::validation("Path must be absolute"));
    }
    if !file_path.is_file() {
        return Err(AppError::file(format!("File not found: {}", path)));
    }

    // Reject paths outside home directory for security
    if let Some(home) = dirs::home_dir() {
        let canonical = file_path
            .canonicalize()
            .map_err(|e| AppError::file(format!("Cannot resolve path: {}", e)))?;
        if !canonical.starts_with(&home) {
            return Err(AppError::validation(
                "read_absolute_file is restricted to files under the user home directory",
            ));
        }
    }

    let content = fs::read_to_string(file_path)
        .map_err(|e| AppError::file(format!("Failed to read file: {}", e)))?;

    // Cap at 64 KB to prevent loading huge files into memory.
    const MAX_BYTES: usize = 64 * 1024;
    if content.len() > MAX_BYTES {
        let mut end = MAX_BYTES;
        while end > 0 && !content.is_char_boundary(end) {
            end -= 1;
        }
        Ok(content[..end].to_string())
    } else {
        Ok(content)
    }
}

#[tauri::command]
pub fn get_home_dir() -> Result<String, AppError> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| AppError::file("Cannot determine home directory"))
}

// ---------------------------------------------------------------------------
// Skill management: install from zip, delete installed skill
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn install_skill_from_zip(
    install_location: String,
    workspace_path: String,
) -> Result<String, String> {
    let zip_path = rfd::FileDialog::new()
        .add_filter("Skill 安装包", &["zip"])
        .set_title("选择 Skill 安装包")
        .pick_file()
        .ok_or_else(|| "用户取消了选择".to_string())?;

    let raw_name = zip_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown-skill");

    // Sanitize skill name
    let skill_name: String = raw_name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if skill_name.is_empty() {
        return Err("无效的 Skill 名称".to_string());
    }

    // Determine target directory based on install location
    let skills_dir = if install_location == "workspace" {
        let ws = workspace_path.trim();
        if ws.is_empty() {
            return Err("未选择工作区，无法安装到工作区".to_string());
        }
        let ws_path = PathBuf::from(ws);
        if !ws_path.is_dir() {
            return Err(format!("工作区路径不存在: {}", ws));
        }
        ws_path.join(".cofree").join("skills")
    } else {
        let home_dir = dirs::home_dir().ok_or("无法获取用户主目录")?;
        home_dir.join(".cofree").join("skills")
    };
    let target_dir = skills_dir.join(&skill_name);

    if target_dir.exists() {
        return Err(format!(
            "Skill \"{}\" 已存在（{}），请先删除旧版本",
            skill_name,
            target_dir.display()
        ));
    }

    // Read and open zip
    let zip_data = fs::read(&zip_path).map_err(|e| format!("读取 zip 文件失败: {}", e))?;
    let reader = std::io::Cursor::new(zip_data);
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| format!("无效的 zip 文件: {}", e))?;

    // Extract to temp directory first
    let temp_dir = std::env::temp_dir().join(format!("cofree-skill-{}", skill_name));
    if temp_dir.exists() {
        let _ = fs::remove_dir_all(&temp_dir);
    }
    fs::create_dir_all(&temp_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("读取 zip 条目失败: {}", e))?;
        let outpath = match file.enclosed_name() {
            Some(path) => temp_dir.join(path),
            None => continue,
        };

        if file.is_dir() {
            fs::create_dir_all(&outpath).ok();
        } else {
            if let Some(parent) = outpath.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("创建目录失败: {}", e))?;
            }
            let mut outfile = fs::File::create(&outpath)
                .map_err(|e| format!("创建文件失败: {}", e))?;
            std::io::copy(&mut file, &mut outfile)
                .map_err(|e| format!("写入文件失败: {}", e))?;
        }
    }

    // If zip has a single top-level directory, use its contents
    let entries: Vec<_> = fs::read_dir(&temp_dir)
        .map_err(|e| format!("读取临时目录失败: {}", e))?
        .filter_map(|e| e.ok())
        .collect();
    let source_dir = if entries.len() == 1 && entries[0].path().is_dir() {
        entries[0].path()
    } else {
        temp_dir.clone()
    };

    // Verify SKILL.md exists
    if !source_dir.join("SKILL.md").exists() {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(
            "安装包中未找到 SKILL.md 文件。请确保 zip 包含 SKILL.md 或包含一个带有 SKILL.md 的文件夹。"
                .to_string(),
        );
    }

    // Move to final location
    fs::create_dir_all(&skills_dir).ok();
    fs::rename(&source_dir, &target_dir).map_err(|e| {
        let _ = fs::remove_dir_all(&temp_dir);
        format!("移动 Skill 到安装目录失败: {}", e)
    })?;

    // Cleanup temp dir
    if source_dir != temp_dir {
        let _ = fs::remove_dir_all(&temp_dir);
    }

    Ok(skill_name)
}

#[tauri::command]
pub fn delete_skill_directory(file_path: String, workspace_path: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    if !path.is_absolute() {
        return Err("路径必须为绝对路径".to_string());
    }

    // Resolve to skill directory (parent of SKILL.md)
    let skill_dir = if path.is_file()
        && path
            .file_name()
            .is_some_and(|n| n == "SKILL.md")
    {
        path.parent().unwrap_or(path).to_path_buf()
    } else {
        path.to_path_buf()
    };

    let canonical = skill_dir
        .canonicalize()
        .map_err(|e| format!("无法解析路径: {}", e))?;

    // Security: allow deleting from ~/.cofree/skills/
    if let Some(home) = dirs::home_dir() {
        let global_skills = home.join(".cofree").join("skills");
        if let Ok(canonical_global) = global_skills.canonicalize() {
            if canonical.starts_with(&canonical_global) && canonical != canonical_global {
                fs::remove_dir_all(&canonical)
                    .map_err(|e| format!("删除 Skill 目录失败: {}", e))?;
                return Ok(());
            }
        }
    }

    // Security: also allow deleting from {workspace}/.cofree/skills/
    let ws = workspace_path.trim();
    if !ws.is_empty() {
        let ws_path = PathBuf::from(ws);
        if let Ok(canonical_ws) = ws_path.canonicalize() {
            let workspace_skills = canonical_ws.join(".cofree").join("skills");
            if canonical.starts_with(&workspace_skills) && canonical != workspace_skills {
                fs::remove_dir_all(&canonical)
                    .map_err(|e| format!("删除 Skill 目录失败: {}", e))?;
                return Ok(());
            }
        }
    }

    Err("只能删除位于 ~/.cofree/skills/ 或工作区 .cofree/skills/ 目录下的 Skill".to_string())
}

#[cfg(test)]
mod tests {
    use super::{build_workspace_edit_patch, extract_symbols, trim_string_to_tail};

    fn names_kinds(content: &str, language: &str) -> Vec<(String, String)> {
        extract_symbols(content, language)
            .into_iter()
            .map(|s| (s.kind, s.name))
            .collect()
    }

    #[test]
    fn ts_extracts_arrow_function_export_const() {
        let src = "export const Greet = (name: string) => `hi ${name}`;\n";
        let symbols = names_kinds(src, "typescript");
        assert_eq!(symbols, vec![("constant".into(), "Greet".into())]);
    }

    #[test]
    fn ts_extracts_default_function_export() {
        let src = "export default function buildPiAiModel(vendor: VendorConfig) {}\n";
        let symbols = names_kinds(src, "typescript");
        assert_eq!(symbols, vec![("function".into(), "buildPiAiModel".into())]);
    }

    #[test]
    fn ts_extracts_async_export_function() {
        let src = "export async function gatewayComplete(): Promise<void> {}\n";
        let symbols = names_kinds(src, "typescript");
        assert_eq!(symbols, vec![("function".into(), "gatewayComplete".into())]);
    }

    #[test]
    fn ts_extracts_default_class_export_with_kind_class() {
        let src = "export default class MainAgent {\n}\n";
        let symbols = names_kinds(src, "typescript");
        assert_eq!(symbols, vec![("class".into(), "MainAgent".into())]);
    }

    #[test]
    fn ts_extracts_top_level_interface() {
        let src = "interface Foo { id: string }\n";
        let symbols = names_kinds(src, "typescript");
        assert_eq!(symbols, vec![("interface".into(), "Foo".into())]);
    }

    #[test]
    fn ts_extracts_class_methods_inside_body() {
        let src = "\
export class Counter {\n\
  count = 0;\n\
  increment(): void { this.count++; }\n\
  async snapshot(): Promise<number> { return this.count; }\n\
  private reset() { this.count = 0; }\n\
}\n";
        let symbols = names_kinds(src, "typescript");
        // Class first, then 3 methods (count is a field with no parens — not matched).
        assert_eq!(
            symbols,
            vec![
                ("class".into(), "Counter".into()),
                ("method".into(), "increment".into()),
                ("method".into(), "snapshot".into()),
                ("method".into(), "reset".into()),
            ]
        );
    }

    #[test]
    fn ts_method_state_machine_skips_top_level_after_class_closes() {
        // After the class body closes, the next top-level function MUST be
        // matched as a top-level function, not as a method.
        let src = "\
class Foo {\n\
  bar() {}\n\
}\n\
export function baz() {}\n";
        let symbols = names_kinds(src, "typescript");
        assert_eq!(
            symbols,
            vec![
                ("class".into(), "Foo".into()),
                ("method".into(), "bar".into()),
                ("function".into(), "baz".into()),
            ]
        );
    }

    #[test]
    fn ts_signature_drops_body_brace() {
        let src = "export function gatewayComplete(opts: Options): Promise<Result> { return doIt(); }\n";
        let symbols = extract_symbols(src, "typescript");
        assert_eq!(symbols.len(), 1);
        assert_eq!(
            symbols[0].signature,
            "export function gatewayComplete(opts: Options): Promise<Result>"
        );
    }

    #[test]
    fn ts_signature_keeps_template_literal_dollar_brace() {
        // `${name}` contains `{` but it's preceded by `$`, not whitespace —
        // the signature heuristic must NOT cut there.
        let src = "export const Greet = (name: string) => `hi ${name}`;\n";
        let symbols = extract_symbols(src, "typescript");
        assert_eq!(symbols.len(), 1);
        assert!(
            symbols[0].signature.contains("${name}"),
            "expected template literal preserved, got {:?}",
            symbols[0].signature
        );
    }

    #[test]
    fn ts_method_blacklist_filters_keywords_used_as_calls() {
        // `if (cond) {` would otherwise look like a method named "if".
        let src = "\
class Guarded {\n\
  run() {\n\
    if (this.ready) { this.go(); }\n\
  }\n\
}\n";
        let symbols = names_kinds(src, "typescript");
        // Only "run" is emitted; the indented `if` and `this.ready` are
        // discarded by the depth gate (depth > class body) plus blacklist.
        assert_eq!(
            symbols,
            vec![
                ("class".into(), "Guarded".into()),
                ("method".into(), "run".into()),
            ]
        );
    }

    #[test]
    fn build_workspace_edit_patch_generates_minimal_hunk() {
        let patch = build_workspace_edit_patch(
            "src/example.ts".to_string(),
            "alpha\nbeta\ngamma\n".to_string(),
            "alpha\nbeta\ninserted\ngamma\n".to_string(),
        )
        .expect("patch should be generated");

        assert!(patch.starts_with("diff --git a/src/example.ts b/src/example.ts\n"));
        assert!(patch.contains("--- a/src/example.ts\n"));
        assert!(patch.contains("+++ b/src/example.ts\n"));
        assert!(patch.contains("@@ -1,3 +1,4 @@\n"));
        assert!(patch.contains("\n beta\n+inserted\n gamma\n"));
        assert!(!patch.contains("\n-alpha\n"));
        assert!(!patch.contains("\n-beta\n"));
        assert!(!patch.contains("\n-gamma\n"));
    }

    #[test]
    fn trim_string_to_tail_keeps_exact_byte_budget_when_boundary_aligns() {
        let mut value = "a中x".to_string();
        trim_string_to_tail(&mut value, 4);
        assert_eq!(value, "中x");
        assert_eq!(value.len(), 4);
    }

    #[test]
    fn trim_string_to_tail_keeps_longest_valid_utf8_suffix_within_limit() {
        let mut value = "中ab".to_string();
        trim_string_to_tail(&mut value, 4);
        assert_eq!(value, "ab");
        assert_eq!(value.len(), 2);
    }
}
