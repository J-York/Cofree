//! 基础设施层：存储、文件系统、Git、HTTP 等外部依赖。

mod checkpoint_repo;
mod paths;

pub use checkpoint_repo::{load_latest_checkpoint, save_checkpoint};
pub use paths::{
    canonicalize_workspace_root, generate_id, snapshots_root_dir, validate_workspace_path,
};
