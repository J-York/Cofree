/*
 * Cofree - AI Programming Cafe
 * Tauri 入口：presentation 层 commands 与 run()。
 * 分层：presentation(commands) → application → domain / infrastructure
 */

mod application;
mod config;
mod domain;
mod infrastructure;
mod secure_store;

use crate::config::{KEYRING_DEFAULT_USER, KEYRING_SERVICE_NAME};
use crate::domain::{
    AppError, AppHealth, CommandExecutionResult, DiagnosticEntry, DiagnosticsResult,
    FetchResult, FileEntry, GitStatus, GlobEntry, GrepMatch, GrepResult, LiteLLMHttpResponse,
    PatchApplyResult, ProxySettings, ReadFileResult, RecoveryResult, SnapshotFileRecord,
    SnapshotManifest, SnapshotResult, StreamChunkEvent, WorkspaceInfo,
};
use crate::infrastructure::{
    canonicalize_workspace_root, generate_id, snapshots_root_dir, validate_workspace_path,
};
use glob::glob as glob_match;
use regex::Regex;
use reqwest::header::ACCEPT;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use futures_util::StreamExt;
use tauri::Emitter;
use tracing::info;

// ── Secure API Key 内存缓存 ──────────────────────────────────────────────────

fn keyring_user_for_profile(profile_id: Option<&str>) -> String {
    match profile_id {
        Some(id) if !id.trim().is_empty() => format!("profile-{}", id.trim()),
        _ => KEYRING_DEFAULT_USER.to_string(),
    }
}

fn api_key_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn keyring_load(user: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE_NAME, user)
        .map_err(|e| format!("创建 keyring entry 失败: {}", e))?;
    match entry.get_password() {
        Ok(password) => Ok(password),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(format!("读取密钥失败: {}", e)),
    }
}

fn keyring_delete_best_effort(user: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE_NAME, user) {
        let _ = entry.delete_credential();
    }
}

fn load_secure_api_key_impl(profile_id: Option<&str>) -> Result<String, String> {
    let user = keyring_user_for_profile(profile_id);
    if let Ok(cache) = api_key_cache().lock() {
        if let Some(cached) = cache.get(&user) {
            return Ok(cached.clone());
        }
    }
    if let Ok(value) = secure_store::load(&user) {
        if !value.is_empty() {
            if let Ok(mut cache) = api_key_cache().lock() {
                cache.insert(user, value.clone());
            }
            return Ok(value);
        }
    }
    let password = keyring_load(&user).unwrap_or_default();
    if !password.is_empty() {
        let _ = secure_store::save(&user, &password);
        keyring_delete_best_effort(&user);
    }
    if let Ok(mut cache) = api_key_cache().lock() {
        cache.insert(user, password.clone());
    }
    Ok(password)
}

fn save_secure_api_key_impl(profile_id: Option<&str>, api_key: &str) -> Result<(), String> {
    let user = keyring_user_for_profile(profile_id);
    secure_store::save(&user, api_key)?;
    if api_key.trim().is_empty() {
        keyring_delete_best_effort(&user);
    }
    if let Ok(mut cache) = api_key_cache().lock() {
        cache.insert(
            user,
            if api_key.trim().is_empty() { String::new() } else { api_key.trim().to_string() },
        );
    }
    Ok(())
}

fn delete_secure_api_key_impl(profile_id: &str) -> Result<(), String> {
    let user = keyring_user_for_profile(Some(profile_id));
    secure_store::delete(&user)?;
    keyring_delete_best_effort(&user);
    if let Ok(mut cache) = api_key_cache().lock() {
        cache.remove(&user);
    }
    Ok(())
}

// ── LiteLLM helpers ──────────────────────────────────────────────────────────

fn normalize_base_url(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
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

// ── Workspace helpers ────────────────────────────────────────────────────────

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
    if sanitized.as_os_str().is_empty() { None } else { Some(sanitized) }
}

fn snapshot_patch_files(
    workspace: &Path,
    snapshot_dir: &Path,
    files: &[String],
) -> Result<Vec<SnapshotFileRecord>, String> {
    let mut records = Vec::new();
    for relative in files {
        let Some(sanitized) = sanitize_relative_path(relative) else { continue };
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
                format!("复制文件快照失败: {} -> {} ({})", target.display(), backup_path.display(), e)
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

// ── Ignore / walk helpers ────────────────────────────────────────────────────

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
    let Some(raw_patterns) = patterns.as_ref() else { return false };
    let normalized_path = normalize_rel_path_for_match(rel_path);
    if normalized_path.is_empty() {
        return false;
    }
    for raw in raw_patterns {
        let Some(pat) = normalize_ignore_pattern(raw) else { continue };
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
            if name.starts_with('.') && path != root {
                if is_ignored_dir(&name) { continue; }
            }
            if is_ignored_dir(&name) { continue; }
            if path.is_dir() {
                queue.push(path);
            } else if path.is_file() {
                result.push(path);
                if result.len() >= max_files { break; }
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
    if config::SHELL_BLOCKED_PATTERNS.iter().any(|pattern| lowered.contains(pattern)) {
        return Err("命令命中高风险关键字（系统级破坏性命令），已拒绝执行".to_string());
    }
    Ok(())
}

fn is_domain_allowed(url: &str) -> bool {
    let parsed = match url::Url::parse(url) {
        Ok(u) => u,
        Err(_) => return false,
    };
    let host = match parsed.host_str() {
        Some(h) => h.to_lowercase(),
        None => return false,
    };
    config::FETCH_ALLOWED_DOMAINS.iter().any(|allowed| {
        host == *allowed || host.ends_with(&format!(".{}", allowed))
    })
}

// ══════════════════════════════════════════════════════════════════════════════
// TAURI COMMANDS (presentation layer)
// ══════════════════════════════════════════════════════════════════════════════

#[tauri::command]
fn healthcheck() -> AppHealth {
    AppHealth {
        status: "ok".to_string(),
        milestone: "1".to_string(),
    }
}

#[tauri::command]
fn select_workspace_folder() -> Result<String, String> {
    rfd::FileDialog::new()
        .pick_folder()
        .ok_or_else(|| "No folder selected".to_string())
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn validate_git_repo(path: String) -> Result<bool, String> {
    let repo_path = Path::new(&path);
    if !repo_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    Ok(true)
}

#[tauri::command]
fn get_workspace_info(path: String) -> Result<WorkspaceInfo, String> {
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
fn read_workspace_file(
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
    let total_lines = if content.is_empty() { 0 } else { segments.len() };
    if start_line.is_none() && end_line.is_none() {
        return Ok(ReadFileResult { content, total_lines, start_line: 1, end_line: total_lines });
    }
    if total_lines == 0 {
        return Ok(ReadFileResult { content: String::new(), total_lines: 0, start_line: 1, end_line: 0 });
    }
    let start = start_line.unwrap_or(1).max(1);
    let requested_end = end_line.unwrap_or(total_lines).max(1);
    if start > requested_end {
        return Err(AppError::validation("start_line 不能大于 end_line"));
    }
    if start > total_lines {
        return Err(AppError::validation(format!("start_line 超出文件范围: {} > {}", start, total_lines)));
    }
    let bounded_end = requested_end.min(total_lines);
    let mut result = String::new();
    for chunk in &segments[(start - 1)..bounded_end] {
        result.push_str(chunk);
    }
    Ok(ReadFileResult { content: result, total_lines, start_line: start, end_line: bounded_end })
}

#[tauri::command]
fn list_workspace_files(
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
        if !path.canonicalize()
            .ok()
            .and_then(|p| dir_path.canonicalize().ok().map(|d| p.starts_with(d)))
            .unwrap_or(false)
        {
            continue;
        }
        let metadata = entry.metadata()
            .map_err(|e| AppError::file(format!("Failed to get metadata: {}", e)))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let modified = metadata.modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let rel_dir = normalize_rel_path_for_match(&relative_path);
        let entry_rel = if rel_dir.is_empty() { name.clone() } else { format!("{}/{}", rel_dir, name) };
        if should_ignore_rel_path(&entry_rel, &ignore_patterns) { continue; }
        entries.push(FileEntry { name, is_dir: metadata.is_dir(), size: metadata.len(), modified });
    }
    Ok(entries)
}

#[tauri::command]
fn git_status_workspace(workspace_path: String) -> Result<GitStatus, String> {
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
    let statuses = repo.statuses(None)
        .map_err(|e| format!("Failed to get git status: {}", e))?;
    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let status = entry.status();
        if status.contains(git2::Status::WT_MODIFIED) || status.contains(git2::Status::INDEX_MODIFIED) {
            result.modified.push(path);
        } else if status.contains(git2::Status::WT_NEW) || status.contains(git2::Status::INDEX_NEW) {
            result.added.push(path);
        } else if status.contains(git2::Status::WT_DELETED) || status.contains(git2::Status::INDEX_DELETED) {
            result.deleted.push(path);
        } else if status.contains(git2::Status::IGNORED) {
            // skip
        } else if !status.is_empty() {
            result.untracked.push(path);
        }
    }
    Ok(result)
}

#[tauri::command]
fn git_diff_workspace(workspace_path: String, file_path: Option<String>) -> Result<String, AppError> {
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
        return Err(AppError::git(if stderr.is_empty() { "执行 git diff 失败".to_string() } else { stderr }));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
fn grep_workspace_files(
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
    let regex = Regex::new(&pattern).map_err(|e| AppError::validation(format!("无效的正则表达式: {}", e)))?;
    let limit = max_results.unwrap_or(config::GREP_DEFAULT_MAX_RESULTS).min(config::GREP_ABSOLUTE_MAX_RESULTS);
    let all_files = walk_workspace_files(&workspace, config::GREP_MAX_FILES);
    let include_pattern = include_glob.as_deref().unwrap_or("");
    let glob_filter: Option<glob::Pattern> = if !include_pattern.is_empty() {
        Some(glob::Pattern::new(include_pattern)
            .map_err(|e| AppError::validation(format!("无效的 glob 模式: {}", e)))?)
    } else {
        None
    };
    let mut matches = Vec::new();
    let mut truncated = false;
    for file_path in &all_files {
        if matches.len() >= limit { truncated = true; break; }
        let rel = to_workspace_relative_string(&workspace, file_path);
        if should_ignore_rel_path(&rel, &ignore_patterns) { continue; }
        if let Some(ref gf) = glob_filter {
            let file_name = file_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if !gf.matches(&file_name) {
                let rel = to_workspace_relative_string(&workspace, file_path);
                if !gf.matches(&rel) { continue; }
            }
        }
        if is_likely_binary(file_path) { continue; }
        let content = match fs::read_to_string(file_path) { Ok(c) => c, Err(_) => continue };
        for (line_idx, line) in content.lines().enumerate() {
            if matches.len() >= limit { truncated = true; break; }
            if regex.is_match(line) {
                let relative = to_workspace_relative_string(&workspace, file_path);
                let trimmed_line = if line.len() > 500 { format!("{}...", &line[..500]) } else { line.to_string() };
                matches.push(GrepMatch { file: relative, line: line_idx + 1, content: trimmed_line });
            }
        }
    }
    Ok(GrepResult { matches, truncated })
}

#[tauri::command]
fn glob_workspace_files(
    workspace_path: String,
    pattern: String,
    max_results: Option<usize>,
    ignore_patterns: Option<Vec<String>>,
) -> Result<Vec<GlobEntry>, AppError> {
    let workspace = canonicalize_workspace_root(&workspace_path)?;
    if pattern.trim().is_empty() {
        return Err(AppError::validation("glob 模式不能为空"));
    }
    let limit = max_results.unwrap_or(config::GLOB_DEFAULT_MAX_RESULTS).min(config::GLOB_ABSOLUTE_MAX_RESULTS);
    let full_pattern = workspace.join(pattern.trim()).to_string_lossy().to_string();
    let mut entries = Vec::new();
    for entry in glob_match(&full_pattern).map_err(|e| AppError::validation(format!("无效的 glob 模式: {}", e)))? {
        if entries.len() >= limit { break; }
        let path = match entry { Ok(p) => p, Err(_) => continue };
        let relative = to_workspace_relative_string(&workspace, &path);
        if should_ignore_rel_path(&relative, &ignore_patterns) { continue; }
        if !path.is_file() { continue; }
        let metadata = match fs::metadata(&path) { Ok(m) => m, Err(_) => continue };
        let modified = metadata.modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        entries.push(GlobEntry { path: relative, size: metadata.len(), modified });
    }
    entries.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(entries)
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
    let workspace = canonicalize_workspace_root(&workspace_path).map_err(|e| e.to_string())?;
    if patch.trim().is_empty() {
        return Err("Patch 不能为空".to_string());
    }
    let mut command = Command::new("git");
    command.arg("-C").arg(&workspace).arg("apply").arg("--whitespace=nowarn");
    if check_only { command.arg("--check"); }
    let mut child = command
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| if check_only { format!("启动 git apply --check 失败: {}", e) } else { format!("启动 git apply 失败: {}", e) })?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(patch.as_bytes()).map_err(|e| format!("写入 patch 失败: {}", e))?;
    } else {
        return Err("无法获取 git apply stdin".to_string());
    }
    let output = child.wait_with_output().map_err(|e| format!("等待 git apply 完成失败: {}", e))?;
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let files = parse_patch_files(&patch);
    if !output.status.success() {
        let detail = if stderr.is_empty() {
            if check_only { "git apply --check 失败".to_string() } else { "git apply 失败".to_string() }
        } else { stderr };
        return Ok(PatchApplyResult { success: false, message: detail, files });
    }
    Ok(PatchApplyResult {
        success: true,
        message: if check_only { format!("Patch 可应用（{} files）", files.len()) } else { format!("Patch 已应用（{} files）", files.len()) },
        files,
    })
}

#[tauri::command]
fn create_workspace_snapshot(workspace_path: String, patch: Option<String>) -> Result<SnapshotResult, String> {
    let workspace = canonicalize_workspace_root(&workspace_path).map_err(|e| e.to_string())?;
    let snapshots_root = snapshots_root_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&snapshots_root).map_err(|e| format!("创建 snapshots 根目录失败: {}", e))?;
    let files = patch.as_deref().map(parse_patch_files).unwrap_or_default();
    let snapshot_id = generate_id("snapshot");
    let snapshot_dir = snapshots_root.join(&snapshot_id);
    fs::create_dir_all(&snapshot_dir).map_err(|e| format!("创建 snapshot 目录失败: {}", e))?;
    let records = snapshot_patch_files(&workspace, &snapshot_dir, &files)?;
    let manifest = SnapshotManifest { files: records.clone() };
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
    let workspace = canonicalize_workspace_root(&workspace_path).map_err(|e| e.to_string())?;
    let Some(snapshot_id_raw) = snapshot_id else {
        return Ok(PatchApplyResult { success: true, message: "未提供快照，跳过回滚".to_string(), files: Vec::new() });
    };
    if snapshot_id_raw.trim().is_empty() {
        return Ok(PatchApplyResult { success: true, message: "未提供快照，跳过回滚".to_string(), files: Vec::new() });
    }
    let snapshot_path = snapshots_root_dir().map_err(|e| e.to_string())?.join(snapshot_id_raw.trim());
    let manifest = load_snapshot_manifest(&snapshot_path)?;
    let mut restored_files = Vec::new();
    for record in manifest.files {
        let Some(sanitized) = sanitize_relative_path(&record.path) else { continue };
        let target = workspace.join(&sanitized);
        if record.existed {
            let backup_relative = record.backup_path.clone()
                .ok_or_else(|| format!("快照缺少备份文件路径: {}", record.path))?;
            let backup_path = snapshot_path.join(&backup_relative);
            if !backup_path.is_file() {
                return Err(format!("快照备份文件不存在: {}", backup_path.display()));
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建恢复目录失败: {}", e))?;
            }
            fs::copy(&backup_path, &target).map_err(|e| {
                format!("恢复文件失败: {} -> {} ({})", backup_path.display(), target.display(), e)
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
    let mut stdout_pipe = child.stdout.take().ok_or_else(|| "读取 stdout 失败".to_string())?;
    let mut stderr_pipe = child.stderr.take().ok_or_else(|| "读取 stderr 失败".to_string())?;
    let started_at = Instant::now();
    let mut timed_out = false;
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started_at.elapsed() >= timeout {
                    timed_out = true;
                    let _ = child.kill();
                    break child.wait().map_err(|e| format!("终止超时命令失败: {}", e))?;
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
        if !stderr.ends_with('\n') && !stderr.is_empty() { stderr.push('\n'); }
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

// ── Checkpoint commands → 委托 application 层 ───────────────────────────────

#[tauri::command]
fn save_workflow_checkpoint(
    session_id: String,
    message_id: String,
    workflow_state: String,
    payload_json: String,
) -> Result<domain::CheckpointRecord, AppError> {
    application::save_workflow_checkpoint(session_id, message_id, workflow_state, payload_json)
}

#[tauri::command]
fn load_latest_workflow_checkpoint(session_id: String) -> Result<RecoveryResult, AppError> {
    application::load_latest_workflow_checkpoint(session_id)
}

// ── LiteLLM commands ─────────────────────────────────────────────────────────

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
    let mut stream_body = body.clone();
    if let Some(obj) = stream_body.as_object_mut() {
        obj.insert("stream".to_string(), Value::Bool(true));
        obj.insert("stream_options".to_string(), serde_json::json!({ "include_usage": true }));
    }
    let mut endpoints = vec![format!("{}/chat/completions", normalized)];
    if !normalized.ends_with("/v1") {
        endpoints.push(format!("{}/v1/chat/completions", normalized));
    }
    let mut errors = Vec::new();
    for (index, endpoint) in endpoints.iter().enumerate() {
        let mut request = client.post(endpoint).header(ACCEPT, "text/event-stream").json(&stream_body);
        if !api_key.trim().is_empty() {
            request = request.bearer_auth(api_key.trim());
        }
        let response = match request.send().await {
            Ok(r) => r,
            Err(e) => { errors.push(format!("{} 请求失败: {}", endpoint, e)); continue; }
        };
        let status = response.status().as_u16();
        if status == 404 && index + 1 < endpoints.len() {
            errors.push(format!("{} 返回 HTTP 404", endpoint));
            continue;
        }
        if !response.status().is_success() {
            let body_text = response.text().await.unwrap_or_default();
            return Ok(LiteLLMHttpResponse { status, body: body_text, endpoint: endpoint.to_string() });
        }
        let mut full_content = String::new();
        let mut finish_reason: Option<String> = None;
        let mut tool_calls_json: Vec<Value> = Vec::new();
        let mut usage_info: Option<Value> = None;
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        while let Some(chunk_result) = stream.next().await {
            let chunk = match chunk_result {
                Ok(c) => c,
                Err(e) => { errors.push(format!("读取流数据失败: {}", e)); break; }
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(newline_pos) = buffer.find('\n') {
                let line = buffer[..newline_pos].trim().to_string();
                buffer = buffer[newline_pos + 1..].to_string();
                if line.is_empty() || line.starts_with(':') { continue; }
                if line == "data: [DONE]" {
                    let _ = app.emit("llm-stream-chunk", StreamChunkEvent {
                        request_id: request_id.clone(), content: String::new(), done: true, finish_reason: finish_reason.clone(),
                    });
                    continue;
                }
                if let Some(data) = line.strip_prefix("data: ") {
                    if let Ok(parsed) = serde_json::from_str::<Value>(data) {
                        if let Some(usage) = parsed.get("usage") {
                            if usage.is_object() && usage.get("prompt_tokens").is_some() {
                                usage_info = Some(usage.clone());
                            }
                        }
                        if let Some(choices) = parsed.get("choices").and_then(Value::as_array) {
                            for choice in choices {
                                if let Some(delta) = choice.get("delta") {
                                    if let Some(content) = delta.get("content").and_then(Value::as_str) {
                                        full_content.push_str(content);
                                        let _ = app.emit("llm-stream-chunk", StreamChunkEvent {
                                            request_id: request_id.clone(), content: content.to_string(), done: false, finish_reason: None,
                                        });
                                    }
                                    if let Some(tc) = delta.get("tool_calls").and_then(Value::as_array) {
                                        for tool_call_delta in tc {
                                            let tc_index = tool_call_delta.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                                            while tool_calls_json.len() <= tc_index {
                                                tool_calls_json.push(serde_json::json!({
                                                    "id": "", "type": "function", "function": { "name": "", "arguments": "" }
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
        let mut message = serde_json::json!({ "role": "assistant", "content": full_content });
        tool_calls_json.retain(|entry| {
            let function = entry.get("function");
            let name_ok = function.and_then(|f| f.get("name")).and_then(Value::as_str).map(|name| !name.trim().is_empty()).unwrap_or(false);
            let args_ok = function.and_then(|f| f.get("arguments")).and_then(Value::as_str).map(|args| !args.trim().is_empty()).unwrap_or(false);
            name_ok && args_ok
        });
        if !tool_calls_json.is_empty() {
            message["tool_calls"] = Value::Array(tool_calls_json);
        }
        let final_usage = usage_info.unwrap_or_else(|| serde_json::json!({ "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }));
        let synthetic_response = serde_json::json!({
            "choices": [{ "message": message, "finish_reason": finish_reason.unwrap_or_else(|| "stop".to_string()) }],
            "usage": final_usage,
        });
        return Ok(LiteLLMHttpResponse {
            status,
            body: serde_json::to_string(&synthetic_response).unwrap_or_default(),
            endpoint: endpoint.to_string(),
        });
    }
    Err(format!("请求 streaming chat/completions 失败: {}", errors.join(" | ")))
}

// ── Secure API key commands ──────────────────────────────────────────────────

#[tauri::command]
fn load_secure_api_key(profile_id: Option<String>) -> Result<String, String> {
    load_secure_api_key_impl(profile_id.as_deref())
}

#[tauri::command]
fn save_secure_api_key(profile_id: Option<String>, api_key: String) -> Result<(), String> {
    save_secure_api_key_impl(profile_id.as_deref(), &api_key)
}

#[tauri::command]
fn delete_secure_api_key(profile_id: String) -> Result<(), String> {
    delete_secure_api_key_impl(&profile_id)
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

// ── Diagnostics command ──────────────────────────────────────────────────────

fn detect_project_type(workspace: &Path) -> &'static str {
    if workspace.join("tsconfig.json").exists() || workspace.join("package.json").exists() {
        return "typescript";
    }
    if workspace.join("Cargo.toml").exists() { return "rust"; }
    if workspace.join("pyproject.toml").exists()
        || workspace.join("setup.py").exists()
        || workspace.join("requirements.txt").exists()
    {
        return "python";
    }
    if workspace.join("go.mod").exists() { return "go"; }
    "unknown"
}

fn parse_tsc_diagnostics(output: &str) -> Vec<DiagnosticEntry> {
    let mut entries = Vec::new();
    let re = Regex::new(r"^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+\w+:\s*(.+)$").unwrap();
    for line in output.lines() {
        if let Some(caps) = re.captures(line.trim()) {
            entries.push(DiagnosticEntry {
                file: caps[1].to_string(), line: caps[2].parse().unwrap_or(0),
                column: caps[3].parse().unwrap_or(0), severity: caps[4].to_string(), message: caps[5].to_string(),
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
                    file: caps[1].to_string(), line: caps[2].parse().unwrap_or(0),
                    column: caps[3].parse().unwrap_or(0), severity: pending_severity.clone(), message: pending_message.clone(),
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
) -> Result<DiagnosticsResult, AppError> {
    let workspace = canonicalize_workspace_root(&workspace_path)?;
    let project_type = detect_project_type(&workspace);
    let (tool_name, output) = match project_type {
        "typescript" => {
            match Command::new("npx").args(["tsc", "--noEmit", "--pretty", "false"])
                .current_dir(&workspace).stdout(Stdio::piped()).stderr(Stdio::piped()).output()
            {
                Ok(out) => ("tsc --noEmit", format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr))),
                Err(_) => ("none", String::new()),
            }
        }
        "rust" => {
            match Command::new("cargo").args(["check", "--message-format=short"])
                .current_dir(&workspace).stdout(Stdio::piped()).stderr(Stdio::piped()).output()
            {
                Ok(out) => ("cargo check", format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr))),
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
                        if let Ok(out) = Command::new("python3").args(["-m", "py_compile", py_file])
                            .current_dir(&workspace).stdout(Stdio::piped()).stderr(Stdio::piped()).output()
                        {
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
        return Ok(DiagnosticsResult { success: true, diagnostics: Vec::new(), tool_used: "none".to_string(), raw_output: String::new() });
    }
    let diagnostics = match project_type {
        "typescript" => parse_tsc_diagnostics(&output),
        "rust" => parse_cargo_diagnostics(&output),
        _ => Vec::new(),
    };
    let filtered = if let Some(ref files) = changed_files {
        let file_set: std::collections::HashSet<&str> = files.iter().map(|f| f.as_str()).collect();
        diagnostics.into_iter().filter(|d| file_set.contains(d.file.as_str())).collect()
    } else {
        diagnostics
    };
    let truncated_output = if output.len() > config::DIAGNOSTICS_OUTPUT_TRUNCATE_LEN {
        format!("{}...(truncated)", &output[..config::DIAGNOSTICS_OUTPUT_TRUNCATE_LEN])
    } else {
        output
    };
    Ok(DiagnosticsResult { success: true, diagnostics: filtered, tool_used: tool_name.to_string(), raw_output: truncated_output })
}

// ── Fetch URL command ────────────────────────────────────────────────────────

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
            success: false, url: url_trimmed.to_string(), content_type: None, content: String::new(), truncated: false,
            error: Some(format!("域名不在白名单中。允许的域名: {}", config::FETCH_ALLOWED_DOMAINS.join(", "))),
        });
    }
    let max_bytes = max_size.unwrap_or(config::FETCH_DEFAULT_MAX_BYTES).min(config::FETCH_DEFAULT_MAX_BYTES);
    let client = build_reqwest_client_with_proxy(proxy, 30)?;
    let response = client.get(url_trimmed)
        .header(ACCEPT, "text/html,application/json,text/plain,*/*")
        .send().await.map_err(|e| format!("请求失败: {}", e))?;
    let status = response.status();
    if !status.is_success() {
        return Ok(FetchResult {
            success: false, url: url_trimmed.to_string(), content_type: None, content: String::new(), truncated: false,
            error: Some(format!("HTTP {}", status.as_u16())),
        });
    }
    let content_type = response.headers().get("content-type").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let bytes = response.bytes().await.map_err(|e| format!("读取响应失败: {}", e))?;
    let truncated = bytes.len() > max_bytes;
    let content_bytes = if truncated { &bytes[..max_bytes] } else { &bytes[..] };
    let content = String::from_utf8_lossy(content_bytes).to_string();
    Ok(FetchResult { success: true, url: url_trimmed.to_string(), content_type, content, truncated, error: None })
}

// ══════════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ══════════════════════════════════════════════════════════════════════════════

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    info!("Cofree starting …");

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
            delete_secure_api_key,
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
