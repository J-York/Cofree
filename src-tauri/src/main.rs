#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
/*
 * Cofree - AI Programming Cafe
 * Tauri 入口：启动 / 插件 / 命令注册。
 * 分层：presentation(commands) → application → domain / infrastructure
 */

mod application;
mod commands;
mod config;
mod domain;
mod infrastructure;
mod secure_store;

use crate::commands::{
    apply_workspace_patch, check_workspace_patch, create_workspace_snapshot, delete_secure_api_key,
    fetch_litellm_models, fetch_url, get_workspace_diagnostics, get_workspace_info,
    git_diff_workspace, git_status_workspace, glob_workspace_files, grep_workspace_files,
    healthcheck, list_workspace_files, load_latest_workflow_checkpoint, load_secure_api_key,
    post_litellm_chat_completions, post_litellm_chat_completions_stream, read_workspace_file,
    restore_workspace_snapshot, run_shell_command, save_file_dialog, save_secure_api_key,
    save_workflow_checkpoint, select_workspace_folder, validate_git_repo,
};
use tauri::Manager;
use tracing::info;

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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("main window not found");
            #[cfg(not(target_os = "macos"))]
            window.set_decorations(false)?;
            window.show()?;
            Ok(())
        })
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
