//! 领域层：实体、值对象、DTO 与统一错误类型。
//! 不依赖基础设施或 Tauri。

mod dto;
mod error;

pub use dto::*;
pub use error::{AppError, AppResult};
