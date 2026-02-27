/*
 * Cofree - AI Programming Cafe
 * File: src-tauri/src/main.rs
 * Milestone: 1
 * Task: 1.1
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Tauri entrypoint for Milestone 1 desktop skeleton.
 */

use serde::Serialize;

#[derive(Clone, Serialize)]
struct AppHealth {
    status: String,
    milestone: String,
}

#[tauri::command]
fn healthcheck() -> AppHealth {
    AppHealth {
        status: "ok".to_string(),
        milestone: "1".to_string(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![healthcheck])
        .run(tauri::generate_context!())
        .expect("error while running cofree tauri application");
}

fn main() {
    run();
}
