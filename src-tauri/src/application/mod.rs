//! 应用层：用例与编排，依赖 domain 与 infrastructure。

mod checkpoint;

pub use checkpoint::{load_latest_workflow_checkpoint, save_workflow_checkpoint};
