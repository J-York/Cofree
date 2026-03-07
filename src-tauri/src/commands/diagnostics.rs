use crate::config;
use crate::domain::{DiagnosticEntry, DiagnosticsResult};
use crate::infrastructure::canonicalize_workspace_root;
use regex::Regex;
use std::path::Path;
use std::process::{Command, Stdio};

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
pub fn get_workspace_diagnostics(
    workspace_path: String,
    changed_files: Option<Vec<String>>,
) -> Result<DiagnosticsResult, crate::domain::AppError> {
    let workspace = canonicalize_workspace_root(&workspace_path)?;
    let project_type = detect_project_type(&workspace);
    let (tool_name, output) = match project_type {
        "typescript" => match Command::new("npx")
            .args(["tsc", "--noEmit", "--pretty", "false"])
            .current_dir(&workspace)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
        {
            Ok(out) => (
                "tsc --noEmit",
                format!(
                    "{}{}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                ),
            ),
            Err(_) => ("none", String::new()),
        },
        "rust" => match Command::new("cargo")
            .args(["check", "--message-format=short"])
            .current_dir(&workspace)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
        {
            Ok(out) => (
                "cargo check",
                format!(
                    "{}{}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                ),
            ),
            Err(_) => ("none", String::new()),
        },
        "python" => {
            if let Some(ref files) = changed_files {
                let py_files: Vec<&String> = files.iter().filter(|f| f.ends_with(".py")).collect();
                if py_files.is_empty() {
                    ("none", String::new())
                } else {
                    let mut combined = String::new();
                    for py_file in py_files.iter().take(10) {
                        if let Ok(out) = Command::new("python3")
                            .args(["-m", "py_compile", py_file])
                            .current_dir(&workspace)
                            .stdout(Stdio::piped())
                            .stderr(Stdio::piped())
                            .output()
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
    let filtered = if let Some(ref files) = changed_files {
        let file_set: std::collections::HashSet<&str> = files.iter().map(|f| f.as_str()).collect();
        diagnostics
            .into_iter()
            .filter(|d| file_set.contains(d.file.as_str()))
            .collect()
    } else {
        diagnostics
    };
    let truncated_output = if output.len() > config::DIAGNOSTICS_OUTPUT_TRUNCATE_LEN {
        format!(
            "{}...(truncated)",
            &output[..config::DIAGNOSTICS_OUTPUT_TRUNCATE_LEN]
        )
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
