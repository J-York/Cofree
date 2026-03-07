//! 工作流检查点应用服务。

use crate::domain::{AppResult, CheckpointRecord, RecoveryResult};
use crate::infrastructure;

pub fn save_workflow_checkpoint(
    session_id: String,
    message_id: String,
    workflow_state: String,
    payload_json: String,
) -> AppResult<CheckpointRecord> {
    infrastructure::save_checkpoint(&session_id, &message_id, &workflow_state, &payload_json)
}

pub fn load_latest_workflow_checkpoint(session_id: String) -> AppResult<RecoveryResult> {
    infrastructure::load_latest_checkpoint(&session_id)
}
