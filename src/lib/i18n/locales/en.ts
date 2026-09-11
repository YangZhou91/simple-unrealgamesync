const en = {
  "settings.language.title": "Language",
  "settings.language.description": "Choose the interface language. Applies instantly.",
  "settings.language.zh": "中文",
  "settings.language.en": "English",
  "steps.closeUe.check": "Closing UE Editor",
  "steps.closeExcel.check": "Closing Excel",
  "steps.cleanDevDir.clean": "Cleaning Dev Directory",
  "steps.p4Sync.toCl": "Syncing to CL {cl}",
  "steps.p4Sync.all": "Syncing Files",
  "steps.genProject.gen": "Generating Project Files",
  "steps.forceSync.force": "Force-syncing Engine…",
  "steps.gitPull.run": "Pulling UnrealEngine…",
  "steps.gitPull.stash": "Saving local changes…",
  "steps.gitPull.preNetwork": "Preparing download…",
  "steps.gitPull.restoreStash": "Restoring local changes…",
  "steps.unknown": "Working…",
  "steps.status.cancelledAt": "Cancelled at {step}",

  // ---- Phase 20: shared common.* ----
  "common.expand": "Expand ▼",
  "common.collapse": "Collapse ▲",
  "common.none": "none",
  "common.close": "Close",

  // ---- Phase 20: CompletionSummaryPanel (SWEEP-04 tracer) ----
  "sync.summary.header.both": "Synced — {warns} warnings / {errors} errors",
  "sync.summary.header.warnings": "Synced — {warns} warnings",
  "sync.summary.header.errors": "Synced — {errors} errors",
  "sync.summary.errors": "Errors",
  "sync.summary.warnings": "Warnings",

  // ---- Phase 20: WorkspaceHealthPanel ----
  "sync.health.title": "Workspace Health",
  // ---- Phase 27: History / Health scan-table chrome ----
  "sync.health.subtitle": "Check local files against Perforce",
  "sync.health.stream": "Current Stream: {stream}",
  "sync.health.unmapped": "Unmapped",
  "sync.health.missingOnDisk": "Missing on disk",
  "sync.health.notInDepot": "Not in depot",
  "sync.health.differs": "Differs",
  "sync.health.needsResolve": "Needs resolve",
  "sync.health.audit": "Audit",
  "sync.health.auditing": "Auditing…",
  "sync.health.retry": "Retry Audit",
  "sync.health.retryHint": "Click Retry Audit to scan again.",
  "sync.health.emptyHint": "Click Audit to scan workspace file status.",
  "sync.health.readonlyFooter":
    "Read-only report — v1 does not offer repair actions",

  // ---- Phase 20: ProgressSection + RunningPanel ----
  "sync.prep": "Preparing… updating {n} files",
  "sync.files.overrun": "{n}+ files…",
  "sync.files.count": "{current}/{total} files",
  "sync.files.noTotal": "{current} files…",
  "sync.running.stream": "Stream:",
  "sync.running.client": "Client:",
  "sync.running.classicClient": "classic client",
  "sync.cancel": "Cancel Sync",
  "sync.cancelling": "Cancelling…",

  // ---- Phase 20: IdlePanel ----
  "sync.idle.ready": "Ready to sync",
  "sync.behind.checking": "Checking Perforce for updates…",
  "sync.behind.one": "{n} file is newer in Perforce",
  "sync.behind.other": "{n} files are newer in Perforce",
  "sync.behind.uptodate": "Workspace is up to date",
  "sync.behind.choose": "Choose a target changelist or sync to HEAD",
  "sync.behind.badge": "Behind {n}",
  "sync.behind.badgeUpToDate": "Up to date",
  "sync.p4.cardTitle": "Perforce project",
  "sync.p4.cardHint": "Sync project content and generate files",
  "sync.badge.p4": "P4",
  // ---- Phase 26 (26-01): canonical idle-surface chrome ----
  "sync.targetCl.headHint": "Leaving blank syncs to the latest revision",
  "sync.pipeline.details": "Five project-sync steps",
  "sync.git.details": "Repository details",
  "sync.p4.currentCl": "Current CL",
  "sync.targetCl": "Target CL (optional)",
  "sync.targetCl.placeholder": "Leave empty for HEAD",
  "sync.targetCl.error": "CL must be a number",
  "sync.engine.checkbox": "Sync UnrealEngine source",
  "sync.engine.hintOn": "Syncing project + UnrealEngine",
  "sync.engine.hintOff": "Syncing project only (engine via Git Pull)",
  "sync.start": "Start Sync",
  "sync.git.cardTitle": "UnrealEngine repository",
  "sync.git.cardHint": "Fast-forward the engine source",
  "sync.badge.git": "Git",
  "sync.git.checking": "Checking repository…",
  "sync.git.dt.branch": "Branch",
  "sync.git.dt.remote": "Remote",
  "sync.git.dt.status": "Status",
  "sync.git.detachedParen": "(detached)",
  "sync.git.status.behind": "Behind {n}",
  "sync.git.status.detached": "Detached HEAD",
  "sync.git.status.uptodate": "Up to date",
  "sync.git.empty": "Repository status unavailable",
  "sync.git.pull": "Git Pull UnrealEngine",
  "sync.last.title": "Latest project sync",
  "sync.last.line": "Last synced: CL #{cl} · {n} files",
  // ---- Phase 26 (26-01 Task 2): cancelled-result chrome ----
  "sync.result.cancelledTitle": "Project sync cancelled",
  // ---- Phase 26 (26-02): canonical running-surface chrome (UI-SPEC §10) ----
  "sync.running.title": "Syncing project",
  "sync.running.targetHead": "Syncing latest revision · HEAD",
  "sync.progress.p4.title": "Syncing project content",
  "sync.progress.filesLabel": "File progress",
  "sync.log.title": "Sync output",

  // ---- Phase 20: ErrorPanel ----
  "sync.error.title": "Sync Failed",
  "sync.error.failedAt": "{step} failed",
  "sync.error.networkCheck": "Network check",
  "sync.error.retry": "Retry Step",
  "sync.error.restart": "Restart Sync",
  "sync.error.dismiss": "Dismiss Error",

  // ---- Phase 20: LogViewer chrome ----
  "sync.log.empty": "Waiting for output…",

  // ---- Phase 20: GitRunningPanel chrome ----
  "sync.git.success": "Git pull completed successfully",
  "sync.git.failed": "Git pull failed",
  "sync.git.unknownError": "Unknown error",
  "sync.git.back": "Back to Idle",
  "sync.git.cancel": "Cancel Pull",
  // Phase 26 (26-03, UI-SPEC §10): canonical Git running/log chrome.
  "sync.git.runningTitle": "Pulling UnrealEngine",
  "sync.git.logTitle": "Git output",

  // ---- Phase 20: SyncDashboard header + tabs ----
  "sync.dash.workspace": "Workspace",
  "sync.dash.noWorkspace": "No workspace selected",
  "sync.dash.stream": "Stream",
  "sync.dash.p4Client": "P4 client",
  "sync.dash.git": "Git",
  "sync.dash.gitChecking": "Checking…",
  "sync.dash.gitDetached": "detached",
  "sync.dash.gitUnavailable": "Unavailable",
  "sync.dash.classicClient": "classic client", // alias of sync.running.classicClient (planner alias — single key reused below)
  "sync.tab.sync": "Sync",
  "sync.tab.history": "History",
  "sync.tab.health": "Health",

  // ---- Phase 20: SettingsDialog proxy-status residue (SWEEP-04 exception) ----
  "settings.proxy.reachable": "✓ Proxy reached GitHub",
  "settings.proxy.reachableWithNote": "✓ Proxy reached GitHub ({note})",
  "settings.proxy.refused":
    "✗ Proxy unreachable: Clash is not listening on {port}",
  "settings.proxy.timeout":
    "✗ Proxy reached but GitHub failed: check Clash rules for github.com",
  "settings.proxy.updateAvailable": "Update available",
  "settings.proxy.error": "✗ {message}",
  "settings.proxy.credentials": "Proxy URLs with usernames or passwords cannot be saved or tested. Use a local proxy without URL credentials.",

  // ---- Phase 21: WorkspaceForm ----
  "workspace.form.title": "Add Workspace",
  "workspace.form.submit": "Add Workspace",
  "workspace.form.dismiss": "Don't Add Workspace",
  "workspace.form.description":
    "Connect a local Unreal Engine project to its Perforce workspace.",
  "workspace.form.name": "Name",
  "workspace.form.namePlaceholder": "My Workspace",
  "workspace.form.rootPath": "Root Path",
  "workspace.form.rootPathPlaceholder": "E:\\UnrealProject",
  "workspace.form.browse": "Browse Folder",
  "workspace.form.projectDir": "Project Directory",
  "workspace.form.projectDirPlaceholder": "MyGame",
  "workspace.form.projectDirHint":
    "Game project subdirectory under the root path (e.g. the folder next to UnrealEngine/).",
  "workspace.form.p4Client": "P4 Client",
  "workspace.form.p4ClientPlaceholder": "my_client_name",
  "workspace.form.p4User": "P4 User",
  "workspace.form.p4UserPlaceholder": "username",
  "workspace.form.error.name": "Name is required",
  "workspace.form.error.rootPath": "Root path is required",
  "workspace.form.error.projectDir": "Project directory is required",
  "workspace.form.error.p4Client": "P4 client is required",
  "workspace.form.error.p4User": "P4 user is required",

  // ---- Phase 21: WorkspaceItem ----
  "workspace.item.clBadge": "CL {cl}",
  "workspace.item.lastSynced": "Last synced: CL #{cl}",
  "workspace.item.neverSynced": "Never synced",
  "workspace.item.deleteAria": "Delete {name}",

  // ---- Phase 21: Sidebar workspace-section ----
  "workspace.sidebar.tagline": "Unreal workspace sync",
  "workspace.sidebar.settingsAria": "Settings",
  "workspace.sidebar.title": "Workspaces",
  "workspace.sidebar.add": "Add Workspace",
  "workspace.sidebar.perforceReady": "Perforce ready",
  "workspace.sidebar.connectedAria": "Connected",

  // ---- Phase 25: Persistent workspace header ----
  "workspace.header.current": "Current workspace",
  "workspace.header.showMetadata": "View Stream and P4 Client",
  "workspace.header.gitUnavailableHelp":
    "Git identity could not be read. Check this workspace's Git repository and configuration.",

  // ---- Phase 21: Workspace empty CTA ----
  "workspace.empty.title": "No Workspaces Yet",
  "workspace.empty.add": "Add workspace",

  // ---- Phase 21: HistoryTab ----
  "history.rollback": "Rollback History",
  "history.rollback.disabledTitle": "Cannot rollback while sync is running",
  "history.loading": "Loading history…",
  "history.empty.title": "No Sync History",
  "history.empty.body": "Completed syncs will appear here.",
  "history.clBadge": "CL #{cl}",
  "history.files": "{n} files",
  // ---- Phase 27: History scan-table chrome ----
  "history.title": "Sync History",
  "history.subtitle": "Completed project syncs for this workspace",
  "history.columns.changelist": "Changelist",
  "history.columns.time": "Sync time",
  "history.columns.duration": "Duration",
  "history.columns.files": "Files",

  // ---- Phase 21: RollbackDialog ----
  "history.rollback.dialogTitle": "Rollback to Changelist",
  "history.rollback.confirmTitle": "Confirm Rollback",
  // ---- Phase 27: Rollback confirm chrome ----
  "history.rollback.confirmSubtitle": "Confirm the project revision to restore.",
  "history.rollback.dialogDesc": "Select a changelist from the server to sync to.",
  "history.rollback.confirmBody":
    "This will sync workspace to CL #{cl}. Any unsynced files at the current revision will be overwritten. Close UE editor before proceeding.",
  "history.rollback.selected": "Selected: CL #{cl}",
  "history.rollback.rollingBack": "Rolling back…",
  "history.rollback.toCl": "Rollback to CL #{cl}",
  "history.rollback.dismiss": "Keep Current CL",
  "history.rollback.loadError":
    "Failed to load changelists. Check P4 connection and try again.",
  "history.rollback.retry": "Retry Load",
  "history.rollback.loadingMore": "Loading changelists…",
  "history.rollback.noMore": "No more changelists",
  "history.rollback.empty": "No changelists on this client.",

  // ---- Phase 22: remaining settings.* + layout.* (SWEEP-03) ----
  "settings.title": "Settings",
  "settings.title.workspace": "Workspace Settings",
  "settings.description": "Diagnostics and log export",
  "settings.description.workspace": "Configure sync options for {name}",
  "settings.startup.title": "Startup",
  "settings.startup.description":
    "Starts hidden to the tray on the next Windows login. Enable this from the installed app so Startup points at the release exe.",
  "settings.startup.launch": "Launch at Windows login",
  "settings.startup.error": "✗ {message}",
  "settings.logs.title": "Logs",
  "settings.logs.resolving": "resolving…",
  "settings.logs.pathAria": "Current log file path",
  "settings.logs.openFolder": "Open logs folder",
  "settings.logs.export": "Export log",
  "settings.logs.exported": "Exported to {dest}",
  "settings.logs.error": "✗ {message}",
  "settings.network.title": "Network",
  "settings.network.description":
    "Route the auto-updater's GitHub traffic through this proxy (e.g. a local Clash mixed-port). Leave off for direct connection.",
  "settings.network.enable": "Enable proxy for auto-updater",
  "settings.network.urlAria": "Proxy URL",
  "settings.network.saveUrl": "Save URL",
  "settings.network.test": "Test connection",
  "settings.network.testing": "Testing…",
  "settings.network.saved": "Saved",
  "settings.threads.label": "Parallel Threads",
  "settings.threads.hint": "Set to 1 to disable parallel sync",
  "settings.behind.label": "Behind-check interval (minutes)",
  "settings.behind.hint": "How often the idle view checks Perforce for pending files",
  "settings.exclusions.title": "Excluded Paths",
  "settings.exclusions.relativeTo": "Paths relative to {projectDir}/",
  "settings.exclusions.projectFallback": "the project",
  "settings.exclusions.removeAria": "Remove {path}",
  "settings.exclusions.inputAria": "Excluded path",
  "settings.exclusions.placeholder": "Add path…",
  "settings.exclusions.add": "Add path",
  "settings.exclusions.error.empty": "Path cannot be empty",
  "settings.exclusions.error.invalid": "Invalid path",
  "settings.exclusions.error.duplicate": "Path already exists",
  "settings.exclusions.missing.one": "Path not found: {paths}",
  "settings.exclusions.missing.other": "Paths not found: {paths}",
  "settings.cancel": "Close without saving",
  "settings.save": "Save workspace settings",

  // ---- Phase 28: settings scope chrome (DLG-01) ----
  "settings.tab.workspace": "This workspace",
  "settings.tab.app": "App settings",
  "settings.tabsAria": "Settings scope",
  "settings.persist.immediate": "Saves immediately",
  "settings.scope.app": "App-wide options",
  "layout.resizeAria": "Resize sidebar",
  "layout.changelog.title": "v{version} Changelog",
  "layout.changelog.description": "Recent changes included in this build.",
  "layout.changelog.empty": "No git history available",
  "layout.updater.availableTitle": "v{version} available — click to install",
  "layout.updater.checkAria": "Check for updates",
  "layout.updater.askTitle": "Update Available",
  "layout.updater.askBody":
    "Version {version} is available. Install now? The app will restart.",
  "layout.updater.askYes": "Yes",
  "layout.updater.askNo": "No",

  // ---- Phase 24: titlebar chrome (SHELL-02) ----
  "titlebar.minimize": "Minimize",
  "titlebar.maximize": "Maximize",
  "titlebar.close": "Close",
} as const;

export default en;
export type MessageKey = keyof typeof en;
