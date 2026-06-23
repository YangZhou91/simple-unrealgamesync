use serde::Serialize;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Process spawn failed: {0}")]
    ProcessSpawn(#[from] std::io::Error),
    #[error("Command '{step}' failed with exit code: {exit_code:?}")]
    CommandFailed {
        step: String,
        exit_code: Option<i32>,
    },
    #[error("P4 command failed with exit code: {0:?}")]
    P4Command(Option<i32>),
    #[error("Store error: {0}")]
    Store(String),
    #[error("Workspace not found: {0}")]
    WorkspaceNotFound(String),
    #[error("Operation cancelled")]
    Cancelled,
    #[error("Process error: {0}")]
    Process(String),
    #[error("Serialization error: {0}")]
    Serialization(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
