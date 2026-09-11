# Changelog

All notable changes to Simple UnrealGameSync will be documented in this file.

## [1.7.0] - 2026-09-08

### Added
- **Language switcher (中文 / English)**: Settings → Language applies instantly without restart. First launch follows the Windows display language; after that the stored choice wins.
- **Full UI localization**: buttons, labels, hints, dialogs, tray notifications, and updater chrome are dictionary-driven in both languages. p4/git logs, file paths, CL numbers, and error payloads stay original.
- **CJK copy gate**: a vitest walk fails if Chinese literals appear outside the dictionary module.

### Changed
- **Live locale re-label**: open dialogs and painted status lines re-translate when you switch language (kind snapshots, not frozen English strings).
- **Updater proxy test**: connectivity results are machine kinds mapped to dictionary copy, so English locale no longer shows a Chinese-only “有新版本” note.

## [1.6.3] - 2026-08-31

### Changed
- **Compact dashboard layout**: the workspace sidebar is denser, and the idle Sync view is split into a readiness strip plus adjacent Perforce and Git action cards.
- **Resizable sidebar**: drag the right edge of the workspace list to widen it (180–420px, persisted across launches) so long workspace names and changelist badges can fit.

### Fixed
- **Truncated sidebar changelist and Stream**: last-synced CL digits stay fully visible in workspace rows, and the header Stream path wraps instead of ellipsizing.

## [1.6.2] - 2026-08-31

### Changed
- **Clearer empty workspace flow**: the empty state now has a direct **Add workspace** action that opens the same form as the sidebar button.
- **Consistent UI copy**: remaining mixed Chinese/English control labels in Settings and sync navigation now follow the app's English interface.

### Fixed
- **Dialogs at the minimum window size**: Settings, Add Workspace, and other dialogs are capped to the viewport and scroll internally, so their titles, controls, and actions remain reachable at the configured 800×500 minimum.
- **Workspace keyboard accessibility**: workspace rows are native buttons with Enter/Space activation and visible focus behavior; delete remains a separate keyboard-accessible action.
- **Form accessibility**: workspace and sync fields now have programmatically associated labels, help text, and validation errors; dialog descriptions remove the previous Radix accessibility warnings.

## [1.6.1] - 2026-08-31

### Added
- **Launch at Windows login** (Settings → Startup / 开机启动): a checkbox (default off) registers the installed app in the current-user Windows startup list via official `tauri-plugin-autostart`. A login launch starts hidden to the tray (`--minimized`) instead of stealing focus. Enable this from the installed release exe, not `tauri dev`.

## [1.6.0] - 2026-07-30

### Added
- **Git pull determinate progress bar (Phase 15)**: during a large UnrealEngine git pull, `GitRunningPanel` now shows a determinate progress bar that climbs with git's own `Receiving objects: N%` / `Resolving deltas: N%` / `Compressing objects: N%`, so a multi-minute engine pull no longer looks frozen (假死). It falls back to the existing indeterminate "Working…" bar — with specific sub-step labels (`Saving local changes…` / `Restoring local changes…` / `Generating project files…` / `Preparing download…`) — during phases git emits no `%` for (stash / restore-stash / GenerateProjectFiles / pre-network `Counting`), and flips back to determinate the moment `%` lines resume. The progress signal is strictly additive and non-fatal: a bad line is skipped, a failed event send is ignored, and the pull's exit code / `files_synced` are never touched. (The determinate bar only appears for pulls with a real object download — small/fast pulls stay on the indeterminate bars, which is the intended behavior.)

### Changed
- **Sync history retention reduced 90 → 30 days** (`HISTORY_RETENTION_DAYS`): older sync-history records are pruned sooner to bound database growth.
- **Startup prune sweep**: on launch the app now clears any sync-history backlog older than the retention window, so a long-unused install won't carry stale records.

## [1.5.4] - 2026-07-27

### Changed
- **Default window widened 960 → 1100px**: new launches now open at 1100px wide, giving more room for the workspace list, log viewer, and history columns. Users who have already manually resized their window are unaffected — Tauri does not persist window size across launches, so existing personalized layouts are not disturbed.

## [1.5.3] - 2026-07-24

### Added
- **Show current UnrealEngine git commit + detached-HEAD status**: the idle panel now shows the short commit hash (e.g. `a1b2c3d`) of the workspace's UnrealEngine (FYEngine) git repo next to the branch name, so you can see exactly which commit/engine version you're on. When the repo is in a detached-HEAD state (common for this dual-VCS UnrealEngine setup where p4 sync pins the git tree to a specific commit), an amber "detached" badge appears and the branch line reads "(detached)" instead of a misleading branch name.

## [1.5.2] - 2026-07-24

### Added
- **"Close Excel before sync"**: a new "Closing Excel" step (mirroring the existing close-Unreal-Editor step) force-kills `EXCEL.EXE` via tasklist+taskkill at all 3 sync entry points — normal sync, rollback, and retry — immediately after the closeUe step. When Excel holds a write lock on a workspace `.xlsx`, p4 sync silently skips that file; this step releases the lock so the sync is complete.

### Changed
- **Faster sync progress bar**: the byte-level progress bar's heartbeat poll tightened from 2s to 0.5s (4× more responsive), so the bar no longer looks frozen during the long heavy-tail transfer phase where p4 emits no stdout. Displayed transfer speed stays accurate — the rate is computed from real elapsed time, not the old fixed poll interval.

## [1.5.1] - 2026-07-21

### Added
- **"Needs resolve" category in the Workspace Health audit**: the health panel now surfaces files left in a conflict-pending (needs-resolve) state after a sync — files p4 won't overwrite because they're open locally AND the depot has a newer revision, so that file's sync is effectively stuck until you run `p4 resolve`. Detected via a 3rd read-only p4 command (`p4 resolve -n`, preview-only — the audit never actually resolves anything). Appears as the 5th category ("需解决 / Needs resolve") alongside unmapped / missing-on-disk / not-in-depot / differs. If your workspace has no such files the category shows 0 (empty). Read-only like the rest of the audit — no fix actions.

## [1.5.0] - 2026-07-21

### Added
- **Sync completion summary panel** (the v1.5 headline): when a sync completes with warnings/errors, the idle screen now shows "同步完成 — N 条 warning / M 条 error" directly below the "Last synced CL" line, with an expandable severity-grouped path list (Errors group first, then Warnings; each group carries a count badge and the affected depot paths). The summary appears for forward sync, force-sync, AND rollback completions — every path that aggregates warnings. When a sync is clean (zero warnings) the idle screen is unchanged: no empty panel, no disturbance. Phase 13 collects p4 warning/error lines from the drains (the `p4 -s` severity tags plus tail-pattern matching for the `info1:` reconcile-warning trap) into one bounded, deduped per-run list carried on `SyncCompleted`; Phase 14 renders it.
- **Sync duration in history records**: each history record now shows how long the sync/rollback took (e.g. `4m 12s`).
- **p4 `-s` scripting mode enabled globally** (infrastructure that enables the warning summary): every p4 spawn now runs in `-s` severity-tagged mode, and all 8 p4 stdout parsers are prefix-hardened to strip `info:`/`warning:`/`error:`/`exit:` tags so the exit-code line never leaks into parsed counts/paths.

### Changed
- **Git pull is now `--ff-only`**: a diverged UnrealEngine branch now hard-fails instead of silently merging (which had accumulated self-loop "Merge branch..." commits in the engine repo). The pull-failure error now names the divergence and directs you to rebase/reset to origin before retrying. The stash → pull → pop flow is otherwise unchanged.

### Fixed
- **History tab column wrapping/clipping**: long file counts and CL badges no longer wrap or clip in the fixed-height history rows.
- **Completion summary panel rendering** (Phase 14 UAT polish): expanding a severity group now actually shows its path list (a LogViewer flex-height collapse left it blank), and the panel width now fits its content — long depot paths are no longer clipped at the right edge.

## [1.4.3] - 2026-07-14

### Added
- **Workspace Health audit**: new "健康 / Workspace Health" tab (3rd, alongside Sync/History) with an on-demand "检查 / Audit" button. Scans the ExampleGame structural whitelist (`Config/` + `Source/` + `ExampleGame.uproject`; Content/Binaries/Intermediate/Saved/Plugins/Build excluded) and surfaces files with abnormal p4 status in 4 categories: **未映射/unmapped** (not in the current client View — e.g. a file stranded after a stream switch; the motivating `ExampleGame.uproject` "not in current workspace mapping" case), **磁盘缺失/missing-on-disk**, **未入库/not-in-depot** (filtered vs generated/ignored patterns), **已修改/differs**. Backed by `p4 reconcile -n -l -I` (3 disk-vs-depot categories) + `p4 where` (unmapped detection — reconcile only processes View-mapped files, so unmapped needs the 2nd command). Read-only v1 (no fix actions). Path lists render via the existing LogViewer (react-virtuoso).

## [1.4.2] - 2026-07-13

### Added
- **"Sync UnrealEngine engine" toggle for Target CL sync (default OFF)**: new checkbox in the Target CL area. With it OFF, a Target CL sync skips the engine source (`UnrealEngine/Engine/{Source,Shaders,Config}/...`) so the post-sync `git pull` of UnrealEngine stays clean — no more `git stash pop failed` on dual-VCS workspaces where `UnrealEngine/` is also a git repo. Rollback always syncs the engine regardless (pinned to the CL). Normal HEAD sync (no Target CL) is unchanged.
- **Test button for the updater proxy**: Settings → 网络/代理 now has a Test/测试连接 button that verifies the configured proxy (default `http://localhost:7897`) reaches GitHub via the updater's first-party `check({ proxy, timeout: 8000 })` API (not a JS `fetch` — tests the real reqwest layer). Errors classified: refused → Clash not listening on the port; timeout → proxy up but GitHub blocked.

### Changed
- RunningPanel now emits a throttled `[ui] render step=.. mode=byteBar|countBar|prep|indeterminate ...` log line mirroring ProgressSection's render priority, so the byte-bar-vs-count-bar decision is directly greppable (was only inferable from backend `disk_usage` lines).

## [1.4.1] - 2026-07-10

### Added
- **Auto-updater local proxy (bypass GFW)**: Settings → 网络/代理 toggle routes the auto-updater's GitHub egress through a local Clash proxy (default `http://localhost:7897`) via the first-party `check({ proxy })` API. For users behind the GFW whose v1.4.0 update wouldn't apply.
- **p4Sync prep state**: indeterminate "正在准备…" bar during the 0–20s window before the first byte sample, so the count bar no longer races to 100% in ~13s during the silent transfer tail.

### Fixed
- **Byte-bar undercount (bar looked stuck at ~13%)**: `DiskUsageSampler` was reading sysinfo's per-interval `written_bytes` field and differencing it again, undercounting ~7.7x (a 9.37 GB sync showed only 1.21 GB on the bar). Now reads the cumulative `total_written_bytes` counter → the bar fills to ~100%.
- **Byte-bar flicker / coverage**: sticky byte-field merge (count↔byte flicker fixed), `bytesRate` rejects 0 (MB/s no longer blinks every ~2s), the byte bar stays visible through the count-overrun tail, and the Revision(@CL) `-N` denominator path-overlap (was inflating to ~969 GB) is resolved.

## [1.4.0] - 2026-07-06

### Added
- **Byte-level sync progress bar**: Real bytes-transferred (via sysinfo `disk_usage()` on the p4 child process) plus a `p4 sync -N` byte denominator drive a progress bar that stays live through the ~6 min silent transfer tail where the file-count bar froze at 100%. File count is shown as a secondary line; bytes and count converge only at 100%.
- **Diagnostic logging stack**: Persistent debug-level file logging (`simple-unrealgamesync.log`, KeepSome(5) + 5 MB rotation, release panic hook with backtrace), a redaction net (paths / P4PORT / emails / depot paths masked before instrumentation), RUN_ID correlation across command/process/step boundaries, and sampled hot-path counters — freeze/stuck bugs in shipped builds are now diagnosable without remote telemetry.
- **In-app log affordances**: "Open logs folder" and "Export log" in Settings.
- **Per-run sync file log**: Each synced file is appended 1:1 with the progress bar to `sync-<run_id>.log` (retained N=3) for post-sync forensics.
- **Workspace p4 stream/client** displayed in the idle/running panel header.

### Changed
- On-disk log file renamed `p4-updater.log` → `simple-unrealgamesync.log` to match the product name.

### Fixed
- **WorkspaceConfig serde**: 6 snake_case fields (`rootPath`/`p4Client`/etc.) were `undefined` on the frontend, producing an empty "Client:" line — now correctly camelCase with snake_case aliases (migration-safe).
- Indeterminate "Working…" bar liveness during the long progress-less force-sync/genProject steps.

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
