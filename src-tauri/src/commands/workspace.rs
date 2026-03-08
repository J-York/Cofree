use crate::config;
use crate::domain::{
    AppError, CommandExecutionResult, FileEntry, FileStructure, GitStatus, GlobEntry, GrepMatch,
    GrepResult, PatchApplyResult, ReadFileResult, SnapshotFileRecord, SnapshotManifest,
    SnapshotResult, SymbolInfo, WorkspaceStructureResult,
};
use crate::infrastructure::{
    canonicalize_workspace_root, generate_id, snapshots_root_dir, validate_workspace_path,
};
use glob::glob as glob_match;
use regex::Regex;
use std::collections::BTreeSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

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
            vec![
                ("export", Regex::new(r"^export\s+(function|class|interface|type|const|enum|abstract\s+class)\s+(\w+)").unwrap()),
                ("function", Regex::new(r"^(?:async\s+)?function\s+(\w+)").unwrap()),
                ("class", Regex::new(r"^class\s+(\w+)").unwrap()),
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
                ("pub", Regex::new(r"^pub\s+(fn|struct|enum|trait|mod|type)\s+(\w+)").unwrap()),
                ("impl", Regex::new(r"^impl(?:<[^>]*>)?\s+(\w+)").unwrap()),
                ("fn", Regex::new(r"^(?:pub\s*(?:\(crate\)\s*)?)?fn\s+(\w+)").unwrap()),
            ]
        }
        "go" => {
            vec![
                ("func", Regex::new(r"^func\s+(?:\([^)]*\)\s+)?(\w+)").unwrap()),
                ("type", Regex::new(r"^type\s+(\w+)\s+(struct|interface)").unwrap()),
            ]
        }
        "java" | "kotlin" => {
            vec![
                ("class", Regex::new(r"(?:public|private|protected)?\s*(?:static\s+)?(?:abstract\s+)?(?:class|interface|enum)\s+(\w+)").unwrap()),
                ("method", Regex::new(r"^\s*(?:public|private|protected)\s+(?:static\s+)?(?:\w+\s+)(\w+)\s*\(").unwrap()),
            ]
        }
        "c" | "cpp" => {
            vec![
                ("function", Regex::new(r"^(?:\w+[\s*]+)+(\w+)\s*\(").unwrap()),
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

fn extract_symbols(content: &str, language: &str) -> Vec<SymbolInfo> {
    let patterns = build_symbol_patterns(language);
    if patterns.is_empty() {
        return Vec::new();
    }

    let max_symbols = config::REPO_MAP_MAX_SYMBOLS_PER_FILE;
    let sig_max_len = config::REPO_MAP_SIGNATURE_MAX_LEN;
    let mut symbols = Vec::new();

    for (line_idx, line) in content.lines().enumerate() {
        if symbols.len() >= max_symbols {
            break;
        }
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('#') || trimmed.starts_with("/*") {
            continue;
        }
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
                let signature = if trimmed.len() > sig_max_len {
                    format!("{}...", &trimmed[..sig_max_len])
                } else {
                    trimmed.to_string()
                };
                symbols.push(SymbolInfo {
                    kind: kind.to_string(),
                    name,
                    line: line_idx + 1,
                    signature,
                });
                break;
            }
        }
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
