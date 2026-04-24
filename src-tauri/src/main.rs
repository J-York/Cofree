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

use crate::commands::ShellJobStore;
use crate::commands::{
    apply_workspace_patch, build_workspace_edit_patch, cancel_http_request, cancel_shell_command,
    check_shell_job, check_workspace_patch,
    create_workspace_snapshot, delete_secure_api_key, delete_skill_directory,
    delete_workflow_checkpoints, fetch_litellm_models, fetch_url,
    get_home_dir, get_workspace_diagnostics, get_workspace_info, git_diff_workspace,
    git_status_workspace, glob_workspace_files, grep_workspace_files, healthcheck,
    install_skill_from_zip, list_workspace_files, load_latest_workflow_checkpoint, load_secure_api_key,
    open_system_terminal, read_absolute_file, read_workspace_file, perform_http_request,
    restore_workspace_snapshot, run_shell_command, save_file_dialog, save_secure_api_key,
    save_workflow_checkpoint, scan_workspace_structure, select_workspace_folder,
    start_shell_command, validate_git_repo,
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ShellJobStore::default())
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
            build_workspace_edit_patch,
            apply_workspace_patch,
            check_workspace_patch,
            create_workspace_snapshot,
            restore_workspace_snapshot,
            run_shell_command,
            start_shell_command,
            cancel_shell_command,
            check_shell_job,
            open_system_terminal,
            grep_workspace_files,
            glob_workspace_files,
            save_workflow_checkpoint,
            load_latest_workflow_checkpoint,
            delete_workflow_checkpoints,
            fetch_litellm_models,
            load_secure_api_key,
            save_secure_api_key,
            delete_secure_api_key,
            save_file_dialog,
            get_workspace_diagnostics,
            fetch_url,
            perform_http_request,
            cancel_http_request,
            scan_workspace_structure,
            read_absolute_file,
            get_home_dir,
            install_skill_from_zip,
            delete_skill_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running cofree tauri application");
}

fn main() {
    run();
}
