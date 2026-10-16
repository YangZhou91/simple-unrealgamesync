use crate::models::SyncEvent;
use crate::services::engine_service::EngineService;
use crate::services::workspace::WorkspaceService;
use crate::utils::counting_channel::CountingChannel;
use crate::utils::log::trace_command;
use std::path::Path;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn engine_update(
    app: AppHandle,
    state: State<'_, Arc<EngineService>>,
    workspace_id: String,
    on_event: Channel<SyncEvent>,
) -> Result<(), String> {
    let args_redacted = crate::utils::redact::redact(&format!("workspace_id={workspace_id}"))
        .into_owned();
    // The lock acquisition lives inside `EngineService::update`, so a refusal
    // still emits the `cmd.exit err` bookend.
    trace_command("engine_update", args_redacted, async move {
        let workspace = WorkspaceService::get(&app, &workspace_id)
            .await
            .map_err(|e| e.to_string())?;
        // D-04 (Phase 12 / HOTUI-12): wrap once at the command boundary so
        // every send in EngineService::update + its drains increments ONE
        // shared Arc<AtomicU64> total.
        let channel = CountingChannel::new(on_event);
        state
            .update(&workspace, &channel)
            .await
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn stop_engine_update(state: State<'_, Arc<EngineService>>) -> Result<(), String> {
    trace_command("stop_engine_update", String::new(), async move {
        state.cancel().await.map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn engine_status(
    app: AppHandle,
    state: State<'_, Arc<EngineService>>,
    workspace_id: String,
) -> Result<Option<String>, String> {
    let args_redacted = crate::utils::redact::redact(&format!("workspace_id={workspace_id}"))
        .into_owned();
    trace_command("engine_status", args_redacted, async move {
        let workspace = WorkspaceService::get(&app, &workspace_id)
            .await
            .map_err(|e| e.to_string())?;
        state
            .engine_cl(&workspace)
            .await
            .map_err(|e| e.to_string())
    })
    .await
}

/// Phase 31 (D-01/D-07, PTHS-01): the pure engine-path predicate.
///
/// Reuses the existing detection primitives verbatim from
/// `services/git_service.rs:97` / `:453` — two local `Path::exists()` stats, no
/// Perforce server round-trip (D-07). `Path::exists()` returns `true` for a
/// `.git` FILE as well as a directory, so worktrees/submodules need no extra
/// branch, and it swallows io errors as `false` — the same behavior as the
/// existing git_service checks, so this needs no special handling.
///
/// Git wins unconditionally on `.git` presence (D-02 / UI-SPEC §9.2): a
/// stale/unreadable `.git` still counts as present. Deriving the git leg from
/// `gitBranchInfo.branch == ""` is forbidden.
fn resolve_engine_path(root: &Path) -> &'static str {
    let ue = root.join("UnrealEngine");
    if ue.join(".git").exists() {
        "git"
    } else if ue.exists() {
        "p4"
    } else {
        "none"
    }
}

/// Phase 31 (PTHS-01): the read-only engine-path probe — the
/// `get_active_operation`-shaped tiny query (no managed service, no Channel, no
/// process spawn) following the `git_status` bookend. Rust NEVER returns
/// `"unknown"` — that token is frontend-only (UI-SPEC §8.1). Errors surface only
/// on workspace-not-found/store failure; the predicate itself cannot fail.
#[tauri::command]
pub async fn engine_path(app: AppHandle, workspace_id: String) -> Result<String, String> {
    let args_redacted = crate::utils::redact::redact(&format!("workspace_id={workspace_id}"))
        .into_owned();
    trace_command("engine_path", args_redacted, async move {
        let workspace = WorkspaceService::get(&app, &workspace_id)
            .await
            .map_err(|e| e.to_string())?;
        Ok(resolve_engine_path(Path::new(&workspace.root_path)).to_string())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::resolve_engine_path;
    use std::fs;
    use std::path::Path;

    #[test]
    fn test_resolve_engine_path_git_dir_wins() {
        let tmp_dir = std::env::temp_dir().join("p4_engine_path_git_dir_wins");
        let _ = fs::remove_dir_all(&tmp_dir);
        // Both UnrealEngine/ AND UnrealEngine/.git (as a directory) exist —
        // git must still win (D-01/D-02).
        fs::create_dir_all(tmp_dir.join("UnrealEngine").join(".git")).unwrap();

        assert_eq!(resolve_engine_path(Path::new(tmp_dir.to_str().unwrap())), "git");

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_resolve_engine_path_git_file_worktree() {
        let tmp_dir = std::env::temp_dir().join("p4_engine_path_git_file_worktree");
        let _ = fs::remove_dir_all(&tmp_dir);
        // A worktree/submodule `.git` is a FILE — Path::exists() is true and
        // git still wins with no extra branch.
        fs::create_dir_all(tmp_dir.join("UnrealEngine")).unwrap();
        fs::write(tmp_dir.join("UnrealEngine").join(".git"), "gitdir: ../.git\n").unwrap();

        assert_eq!(resolve_engine_path(Path::new(tmp_dir.to_str().unwrap())), "git");

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_resolve_engine_path_p4_leg() {
        let tmp_dir = std::env::temp_dir().join("p4_engine_path_p4_leg");
        let _ = fs::remove_dir_all(&tmp_dir);
        // UnrealEngine/ present, no .git -> "p4".
        fs::create_dir_all(tmp_dir.join("UnrealEngine")).unwrap();

        assert_eq!(resolve_engine_path(Path::new(tmp_dir.to_str().unwrap())), "p4");

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_resolve_engine_path_none() {
        let tmp_dir = std::env::temp_dir().join("p4_engine_path_none");
        let _ = fs::remove_dir_all(&tmp_dir);
        // Neither UnrealEngine/.git nor UnrealEngine/ -> "none".
        fs::create_dir_all(&tmp_dir).unwrap();

        assert_eq!(resolve_engine_path(Path::new(tmp_dir.to_str().unwrap())), "none");

        let _ = fs::remove_dir_all(&tmp_dir);
    }
}
