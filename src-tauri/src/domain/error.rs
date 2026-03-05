//! 统一应用错误类型，用于全栈 `Result<T, AppError>`。
//! 实现 `Serialize` 以便 Tauri 将错误返回前端（序列化为单字符串以保持兼容）。

use serde::Serialize;
use thiserror::Error;

/// 应用层统一错误类型。
/// 各层将具体错误映射为此类型，presentation 层可序列化为字符串或结构化 JSON。
#[derive(Error, Debug)]
pub enum AppError {
    #[error("{0}")]
    Workspace(String),

    #[error("{0}")]
    Git(String),

    #[error("{0}")]
    File(String),

    #[error("{0}")]
    SecureStore(String),

    #[error("{0}")]
    Checkpoint(String),

    #[error("{0}")]
    LiteLLM(String),

    #[error("{0}")]
    Http(String),

    #[error("{0}")]
    Shell(String),

    #[error("{0}")]
    Config(String),

    #[error("{0}")]
    Validation(String),

    #[error("{0}")]
    Other(String),
}

#[allow(dead_code)]
impl AppError {
    pub fn workspace(msg: impl Into<String>) -> Self {
        AppError::Workspace(msg.into())
    }
    pub fn git(msg: impl Into<String>) -> Self {
        AppError::Git(msg.into())
    }
    pub fn file(msg: impl Into<String>) -> Self {
        AppError::File(msg.into())
    }
    pub fn secure_store(msg: impl Into<String>) -> Self {
        AppError::SecureStore(msg.into())
    }
    pub fn checkpoint(msg: impl Into<String>) -> Self {
        AppError::Checkpoint(msg.into())
    }
    pub fn litellm(msg: impl Into<String>) -> Self {
        AppError::LiteLLM(msg.into())
    }
    pub fn http(msg: impl Into<String>) -> Self {
        AppError::Http(msg.into())
    }
    pub fn shell(msg: impl Into<String>) -> Self {
        AppError::Shell(msg.into())
    }
    pub fn config(msg: impl Into<String>) -> Self {
        AppError::Config(msg.into())
    }
    pub fn validation(msg: impl Into<String>) -> Self {
        AppError::Validation(msg.into())
    }
    pub fn other(msg: impl Into<String>) -> Self {
        AppError::Other(msg.into())
    }
}

/// 前端兼容：序列化为单字符串，与原有 `Result<_, String>` 行为一致。
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// 用于在 presentation 层将 `Result<T, AppError>` 转为 Tauri 可接受的错误类型。
pub type AppResult<T> = Result<T, AppError>;
