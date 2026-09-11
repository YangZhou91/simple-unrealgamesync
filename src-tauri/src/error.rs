use serde::Serialize;
use thiserror::Error;

#[derive(Error)]
pub enum AppError {
    #[error("Process spawn failed: {0}")]
    ProcessSpawn(#[from] std::io::Error),
    /// SC#3 allowlist: `exit_code` is `Option<i32>` (a non-sensitive process exit
    /// code — an integer, NOT identity/path/credential). `{:?}` is the only way to
    /// render `Option<i32>` in thiserror's `#[error]` (format! semantics, no
    /// Display). Kept per D-04 documented allowlist. The Wave 1 `redact()` net
    /// masks any path this Display renders when the error is logged via `{e}`.
    #[error("Command '{step}' failed with exit code: {exit_code:?}")]
    CommandFailed {
        step: String,
        exit_code: Option<i32>,
    },
    /// SC#3 allowlist: `P4Command` wraps `Option<i32>` exit code (non-sensitive
    /// integer, NOT identity/path/credential). `{:?}` is the only Display-free
    /// render in thiserror's `#[error]`. Kept per D-04 documented allowlist.
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

/// Manual `Debug` for `AppError` — the REDACT-06 / D-05 defense-in-depth
/// backstop for the error enum.
///
/// thiserror-2 generates ONLY `Display` (verified
/// `thiserror-impl-2.0.18/src/expand.rs:158,433`); the `Error` trait impl
/// requires `Self: Debug` as a *bound* (not auto-provided, `fallback.rs:22`),
/// which this manual impl satisfies. Dropping `Debug` from `#[derive(Error)]`
/// keeps the `#[error("...")]` Display impls intact.
///
/// Per D-05, the format-layer `redact()` net (Wave 1) is the ONLY layer that
/// protects the Display / error-chain / panic / `io::Error` paths (they render
/// to a string before any struct is involved — and `AppError` is logged via
/// `{e}` Display, not `{:?}`). This struct-level `Debug` is a pragmatic,
/// testable backstop that masks the OBVIOUS sensitive payloads (string
/// payloads on `Store` / `WorkspaceNotFound` / `Process` / `Serialization`,
/// the `io::Error` on `ProcessSpawn`, and the `exit_code` on `CommandFailed`)
/// so `{:?}` formatting cannot leak them even before the net sees the rendered
/// string. The variant name is retained so `Debug` remains useful.
impl std::fmt::Debug for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // ProcessSpawn wraps io::Error; its Display message is arbitrary
            // (often a path or OS message), so mask it like the other variants.
            // The format-layer net catches any path the Display renders when the
            // error is logged via `{e}` (Display); this Debug backstop masks the
            // raw payload for the {:?} path.
            AppError::ProcessSpawn(_) => f
                .debug_tuple("ProcessSpawn")
                .field(&"<redacted>")
                .finish(),
            AppError::CommandFailed { step, .. } => f
                .debug_struct("CommandFailed")
                .field("step", &step)
                .field("exit_code", &"<redacted>")
                .finish(),
            AppError::P4Command(_) => f.debug_tuple("P4Command").field(&"<redacted>").finish(),
            AppError::Store(_) => f.debug_tuple("Store").field(&"<redacted>").finish(),
            AppError::WorkspaceNotFound(_) => {
                f.debug_tuple("WorkspaceNotFound").field(&"<redacted>").finish()
            }
            AppError::Cancelled => write!(f, "Cancelled"),
            AppError::Process(_) => f.debug_tuple("Process").field(&"<redacted>").finish(),
            AppError::Serialization(_) => {
                f.debug_tuple("Serialization").field(&"<redacted>").finish()
            }
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- SC#2: manual Debug does not leak payloads (REDACT-06 / D-05 backstop) ----

    #[test]
    fn debug_does_not_leak_payloads() {
        // One fixture per sensitive-payload variant. The format-layer redact()
        // net is the audited boundary; this struct-level Debug is the pragmatic
        // backstop that masks the OBVIOUS payloads so {:?} cannot leak them.
        let store =
            AppError::Store("C:\\Users\\alice\\secret".into());
        let not_found = AppError::WorkspaceNotFound("alice-laptop".into());
        let process_spawn = AppError::ProcessSpawn(std::io::Error::new(
            std::io::ErrorKind::Other,
            "C:\\Users\\alice\\io",
        ));
        let command_failed = AppError::CommandFailed {
            step: "p4Sync".into(),
            exit_code: Some(1),
        };

        for (label, variant, variant_name) in [
            ("Store", &store, "Store"),
            ("WorkspaceNotFound", &not_found, "WorkspaceNotFound"),
            ("ProcessSpawn", &process_spawn, "ProcessSpawn"),
            ("CommandFailed", &command_failed, "CommandFailed"),
        ] {
            let dbg = format!("{:?}", variant);
            assert!(
                !dbg.contains("alice"),
                "{label} Debug leaked username: {dbg}"
            );
            assert!(
                !dbg.contains(r"C:\Users"),
                "{label} Debug leaked path: {dbg}"
            );
            assert!(
                dbg.contains(variant_name),
                "{label} Debug must still identify the variant"
            );
        }
    }

    #[test]
    fn debug_command_failed_masks_exit_code() {
        // Targeted: exit_code is masked even though step is kept.
        let err = AppError::CommandFailed {
            step: "gitPull".into(),
            exit_code: Some(42),
        };
        let dbg = format!("{:?}", err);
        assert!(dbg.contains("gitPull"), "step is non-identity, keep it");
        assert!(!dbg.contains("42"), "exit_code must be masked: {dbg}");
        assert!(dbg.contains("CommandFailed"));
    }
}
