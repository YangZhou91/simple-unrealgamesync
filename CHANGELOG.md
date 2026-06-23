# Changelog

All notable changes to Simple UnrealGameSync will be documented in this file.

## [0.4.0] - 2026-06-12

### Added
- **Idle Perforce behind-check**: Idle view automatically runs a `p4 sync -n` dry-run ~2 min after load and then on a configurable interval, showing a "Behind N files" / "Up to date" badge (mirrors the Git-behind indicator). Display-only, paused while a sync is running. (#9c516ba, #26d4ff7, #36c25fe)
- **Behind-check interval setting**: Configurable check interval (minutes) in workspace settings, default 60. (#36c25fe)

### Changed
- **Conditional Engine force sync**: The UnrealEngine `p4 sync -f` force sync now runs only when a target changelist is provided. An empty changelist performs a lightweight project-only update and skips the ~5 min Engine force sync. (#d3d9c91)

### Fixed
- **Recover UI when completion event is lost**: The sync command's resolution is now an authoritative completion signal, so a dropped `syncCompleted` Channel event (WebView2 throttling while backgrounded) no longer leaves the UI stuck on "syncing". (#c08ad60)
- **Progress bar 假死 during forceSync/genProject**: These long, progress-less steps now show an animated indeterminate progress bar instead of a frozen one. (#5661639, #cdf247a)

## [0.3.1] - 2026-06-11

### Added
- Generate ProjectFiles after git pull (#4eeff3a)
- Validate exclusion paths exist under the project directory (#0a3b4df)
- Git commit history in changelog dialog (#f33396c)
- Track p4 PID for taskkill fallback, add cancel UI feedback (#f30f8e2)

### Fixed
- Recover UI from stale WebView state during sync (#df9e3bf)
- Dialog close button visibility on dark theme (#1a6d2d4, #ed176fb)
- Hide console windows when spawning subprocesses (#099ba51)
- Dry-run timeout, cancellation support, progress feedback (#5f0a0d5)

## [0.3.0] - 2026-06-05

### Added
- **Git Branch Status UI**: Display git branch name and status in SyncDashboard and IdlePanel
- **Git Branch Status Backend**: `git_service.rs` branch status query support

### Fixed
- **Hide Console Windows**: 隐藏所有子进程（p4、git、tasklist、taskkill、cmd）的黑色命令行窗口，执行同步等操作时不再弹出控制台框

## [0.2.0] - 2026-06-05

### Added
- **Git Integration**: Full Git pull support with branch name and behind-count display in UI
- **Git Service**: Backend `GitService` with `git_pull` and `stop_git_pull` commands
- **Git Pull Frontend**: `useGit` hook, `GitRunningPanel` component, and full wiring
- **Git Branch Status**: Show branch name and behind count in sidebar
- **System Tray**: System tray icon with context menu and close-to-tray behavior
- **Sync State Events**: Emit sync-state events and wire tray tooltip/notifications
- **Network Check**: Pre-sync connectivity check with `networkCheck` retry routing
- **Scope Hint**: Show sync scope hint in UI

### Fixed
- Restore stashed changes on Git pull failure and cancel paths
- Add `AtomicBool` concurrency guard to `GitService`
- Refresh git branch info after successful pull
- Remove unused `cancelled` state from `GitState`
- Remove optimistic state change from `stopGitPull`
- Propagate spawn failures from `run_git` instead of swallowing
- Use explicit remote/branch for ahead-behind instead of `@{upstream}`
- Stash local changes before pull, restore after
- Log `dry_run` errors instead of silently swallowing
- Show "Restart Sync" label for network check errors
- Reset `stepStatuses` on retry
- Remove dead `SyncStep` enum and its re-export
- Remove optimistic cancelled state in `stopSync`
- Verify numeric CL before treating line as new changelist entry
- Return constructed workspace from `add` instead of `.last()` lookup
- Reject absolute paths and drive letters in exclusion validator
- Clamp `parallel_threads` to [1,16] via custom deserializer
- Validate `target_cl` in `retry_step` and `start_sync` commands
- Auto-prune zero-file sync records from history display
- Add missing `--color-muted-foreground` CSS variable
- Improve dialog close button visibility on dark theme
- Fix CL input unable to type in dev mode due to Radix TabsContent tabIndex

## [0.1.0] - 2026-06-02

### Added
- **Project Scaffold**: Tauri 2 project with TypeScript type system and layout shell
- **Rust Backend**: P4 sync services, workspace management, and Tauri commands
- **Frontend Hooks**: `useSync`, `useWorkspaces` hooks and React components
- **Sync Options**: Wire `SyncOptions` through pipeline, `update_workspace_settings` command
- **CL Input**: Changelist input with step descriptions wiring
- **Settings Dialog**: Gear icon in sidebar, settings dialog with persistence
- **CL Badge**: Tooltip explaining workspace changelist, auto-refresh on sync complete
- **History**: `HistoryRecord`/`ChangelistEntry` models, `HistoryService` with auto-prune
- **Rollback**: Parse changelists, rollback pipeline with confirmation dialog
- **Tabs Layout**: History tab, rollback dialog, tabs in `SyncDashboard`
- **Resizable Panel**: Log viewer area with resizable panel
- **Window Resizing**: Enabled window resizing with min size constraints

### Fixed
- Resolve 3 critical review findings + warnings
- Fix `parallelThreads` not persisting in `SettingsDialog`
- Fix P4 sync progress, nested exclusions, and `clean_developers` path
- Add `CommandFailed` error variant and `stop_all` method
- Enable horizontal scrolling for long file paths in sync display
