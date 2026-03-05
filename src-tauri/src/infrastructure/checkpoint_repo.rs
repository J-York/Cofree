//! 工作流检查点持久化（SQLite）。

use crate::domain::{AppError, AppResult, CheckpointRecord, RecoveryResult};
use crate::infrastructure::paths;
use rusqlite::{params, Connection};
use std::fs;

fn ensure_checkpoint_table(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS workflow_checkpoints (
            checkpoint_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            workflow_state TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_checkpoint_session_updated
          ON workflow_checkpoints(session_id, updated_at DESC);",
    )
    .map_err(|e| AppError::checkpoint(format!("初始化 checkpoint 表失败: {}", e)))
}

pub fn save_checkpoint(
    session_id: &str,
    message_id: &str,
    workflow_state: &str,
    payload_json: &str,
) -> AppResult<CheckpointRecord> {
    if session_id.trim().is_empty() || message_id.trim().is_empty() {
        return Err(AppError::validation("session_id / message_id 不能为空"));
    }
    if payload_json.trim().is_empty() {
        return Err(AppError::validation("payload_json 不能为空"));
    }
    serde_json::from_str::<serde_json::Value>(payload_json)
        .map_err(|e| AppError::validation(format!("payload_json 不是合法 JSON: {}", e)))?;

    let db_path = paths::sqlite_db_path()?;
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::checkpoint(format!("创建 checkpoint 目录失败: {}", e)))?;
    }
    let conn = Connection::open(&db_path).map_err(|e| AppError::checkpoint(format!("打开 checkpoint DB 失败: {}", e)))?;
    ensure_checkpoint_table(&conn)?;

    let checkpoint_id = paths::generate_id("cp");
    let now = paths::now_timestamp();
    conn.execute(
        "INSERT INTO workflow_checkpoints
          (checkpoint_id, session_id, message_id, workflow_state, payload_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            checkpoint_id,
            session_id.trim(),
            message_id.trim(),
            workflow_state.trim(),
            payload_json,
            now,
            now
        ],
    )
    .map_err(|e| AppError::checkpoint(format!("保存 checkpoint 失败: {}", e)))?;

    Ok(CheckpointRecord {
        checkpoint_id: checkpoint_id.clone(),
        session_id: session_id.trim().to_string(),
        message_id: message_id.trim().to_string(),
        workflow_state: workflow_state.trim().to_string(),
        payload_json: payload_json.to_string(),
        created_at: now.clone(),
        updated_at: now,
    })
}

pub fn load_latest_checkpoint(session_id: &str) -> AppResult<RecoveryResult> {
    if session_id.trim().is_empty() {
        return Err(AppError::validation("session_id 不能为空"));
    }
    let db_path = paths::sqlite_db_path()?;
    if !db_path.exists() {
        return Ok(RecoveryResult {
            found: false,
            checkpoint: None,
        });
    }

    let conn = Connection::open(&db_path).map_err(|e| AppError::checkpoint(format!("打开 checkpoint DB 失败: {}", e)))?;
    ensure_checkpoint_table(&conn)?;

    let mut stmt = conn
        .prepare(
            "SELECT checkpoint_id, session_id, message_id, workflow_state, payload_json, created_at, updated_at
             FROM workflow_checkpoints
             WHERE session_id = ?1
             ORDER BY updated_at DESC
             LIMIT 1",
        )
        .map_err(|e| AppError::checkpoint(format!("准备查询 checkpoint 失败: {}", e)))?;

    let mut rows = stmt
        .query(params![session_id.trim()])
        .map_err(|e| AppError::checkpoint(format!("查询 checkpoint 失败: {}", e)))?;

    if let Some(row) = rows.next().map_err(|e| AppError::checkpoint(format!("读取 checkpoint 失败: {}", e)))? {
        let checkpoint = CheckpointRecord {
            checkpoint_id: row.get(0).map_err(|e| AppError::checkpoint(format!("读取 checkpoint_id 失败: {}", e)))?,
            session_id: row.get(1).map_err(|e| AppError::checkpoint(format!("读取 session_id 失败: {}", e)))?,
            message_id: row.get(2).map_err(|e| AppError::checkpoint(format!("读取 message_id 失败: {}", e)))?,
            workflow_state: row.get(3).map_err(|e| AppError::checkpoint(format!("读取 workflow_state 失败: {}", e)))?,
            payload_json: row.get(4).map_err(|e| AppError::checkpoint(format!("读取 payload_json 失败: {}", e)))?,
            created_at: row.get(5).map_err(|e| AppError::checkpoint(format!("读取 created_at 失败: {}", e)))?,
            updated_at: row.get(6).map_err(|e| AppError::checkpoint(format!("读取 updated_at 失败: {}", e)))?,
        };
        return Ok(RecoveryResult {
            found: true,
            checkpoint: Some(checkpoint),
        });
    }

    Ok(RecoveryResult {
        found: false,
        checkpoint: None,
    })
}
