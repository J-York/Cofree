//! 基础设施层：存储、文件系统、Git、HTTP 等外部依赖。

mod checkpoint_repo;
mod paths;

pub use checkpoint_repo::{
    delete_checkpoints_by_session_prefix, load_latest_checkpoint, save_checkpoint,
};
pub use paths::{
    canonicalize_workspace_root, generate_id, snapshots_root_dir, resolve_workspace_or_absolute_path,
};
