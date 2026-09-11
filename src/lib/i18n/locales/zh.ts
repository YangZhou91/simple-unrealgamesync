import { type MessageKey } from "./en";

const zh: Record<MessageKey, string> = {
  "settings.language.title": "语言",
  "settings.language.description": "选择界面语言，立即生效。",
  "settings.language.zh": "中文",
  "settings.language.en": "English",
  "steps.closeUe.check": "关闭 UE 编辑器",
  "steps.closeExcel.check": "关闭 Excel",
  "steps.cleanDevDir.clean": "清理 Dev 目录",
  "steps.p4Sync.toCl": "同步至 CL {cl}",
  "steps.p4Sync.all": "同步文件",
  "steps.genProject.gen": "生成项目文件",
  "steps.forceSync.force": "强制同步引擎…",
  "steps.gitPull.run": "正在拉取 UnrealEngine…",
  "steps.gitPull.stash": "保存本地更改…",
  "steps.gitPull.preNetwork": "准备下载…",
  "steps.gitPull.restoreStash": "恢复本地更改…",
  "steps.unknown": "进行中…",
  "steps.status.cancelledAt": "已取消于 {step}",

  // ---- Phase 20: shared common.* ----
  "common.expand": "展开 ▼",
  "common.collapse": "收起 ▲",
  "common.none": "无",
  "common.close": "关闭",

  // ---- Phase 20: CompletionSummaryPanel (SWEEP-04 tracer) ----
  // D-02: zh header keeps Latin warning/error (matches p4 -s tags).
  "sync.summary.header.both": "同步完成 — {warns} 条 warning / {errors} 条 error",
  "sync.summary.header.warnings": "同步完成 — {warns} 条 warning",
  "sync.summary.header.errors": "同步完成 — {errors} 条 error",
  "sync.summary.errors": "错误",
  "sync.summary.warnings": "警告",

  // ---- Phase 20: WorkspaceHealthPanel ----
  "sync.health.title": "工作区健康",
  // ---- Phase 27: History / Health scan-table chrome ----
  "sync.health.subtitle": "检查本地文件与 Perforce 的状态",
  "sync.health.stream": "当前 Stream: {stream}",
  "sync.health.unmapped": "未映射",
  "sync.health.missingOnDisk": "磁盘缺失",
  "sync.health.notInDepot": "未入库",
  "sync.health.differs": "已修改",
  "sync.health.needsResolve": "需解决",
  "sync.health.audit": "检查",
  "sync.health.auditing": "检查中…",
  "sync.health.retry": "重试检查",
  "sync.health.retryHint": "点击「重试检查」重新检查。",
  "sync.health.emptyHint": "点击「检查」开始扫描工作区文件状态。",
  "sync.health.readonlyFooter": "只读报告 — v1 不提供修复操作",

  // ---- Phase 20: ProgressSection + RunningPanel ----
  "sync.prep": "正在准备… 将更新 {n} 个文件",
  "sync.files.overrun": "{n}+ 个文件…",
  "sync.files.count": "{current}/{total} 个文件",
  "sync.files.noTotal": "{current} 个文件…",
  "sync.running.stream": "Stream:",
  "sync.running.client": "Client:",
  "sync.running.classicClient": "classic client",
  "sync.cancel": "取消同步",
  "sync.cancelling": "取消中…",

  // ---- Phase 20: IdlePanel ----
  "sync.idle.ready": "准备同步",
  "sync.behind.checking": "正在检查 Perforce 更新…",
  "sync.behind.one": "{n} 个文件较新",
  "sync.behind.other": "{n} 个文件较新",
  "sync.behind.uptodate": "工作区已是最新",
  "sync.behind.choose": "选择目标 CL 或同步至 HEAD",
  "sync.behind.badge": "Behind {n}",
  "sync.behind.badgeUpToDate": "Up to date",
  "sync.p4.cardTitle": "Perforce 项目",
  "sync.p4.cardHint": "同步项目内容并生成文件",
  "sync.badge.p4": "P4",
  // ---- Phase 26 (26-01): canonical idle-surface chrome ----
  "sync.targetCl.headHint": "留空将同步到最新版本",
  "sync.pipeline.details": "项目同步的 5 个步骤",
  "sync.git.details": "仓库详情",
  "sync.p4.currentCl": "当前 CL",
  "sync.targetCl": "目标 CL（可选）",
  "sync.targetCl.placeholder": "留空即 HEAD",
  "sync.targetCl.error": "CL 必须是数字",
  "sync.engine.checkbox": "同步 UnrealEngine 源码",
  "sync.engine.hintOn": "同步项目 + UnrealEngine",
  "sync.engine.hintOff": "仅同步项目（引擎通过 Git Pull）",
  "sync.start": "开始同步",
  "sync.git.cardTitle": "UnrealEngine 仓库",
  "sync.git.cardHint": "快进引擎源码",
  "sync.badge.git": "Git",
  "sync.git.checking": "正在检查仓库…",
  "sync.git.dt.branch": "Branch",
  "sync.git.dt.remote": "Remote",
  "sync.git.dt.status": "Status",
  "sync.git.detachedParen": "(detached)",
  "sync.git.status.behind": "Behind {n}",
  "sync.git.status.detached": "Detached HEAD",
  "sync.git.status.uptodate": "Up to date",
  "sync.git.empty": "仓库状态不可用",
  "sync.git.pull": "拉取 UnrealEngine",
  "sync.last.title": "最近项目同步",
  "sync.last.line": "上次同步：CL #{cl} · {n} 个文件",
  // ---- Phase 26 (26-01 Task 2): cancelled-result chrome ----
  "sync.result.cancelledTitle": "项目同步已取消",
  // ---- Phase 26 (26-02): canonical running-surface chrome (UI-SPEC §10) ----
  "sync.running.title": "正在同步项目",
  "sync.running.targetHead": "同步至最新版本 · HEAD",
  "sync.progress.p4.title": "正在同步项目内容",
  "sync.progress.filesLabel": "文件进度",
  "sync.log.title": "同步输出",

  // ---- Phase 20: ErrorPanel ----
  "sync.error.title": "同步失败",
  "sync.error.failedAt": "{step} 失败",
  "sync.error.networkCheck": "网络检查",
  "sync.error.retry": "重试此步骤",
  "sync.error.restart": "重新开始同步",
  "sync.error.dismiss": "关闭错误",

  // ---- Phase 20: LogViewer chrome ----
  "sync.log.empty": "等待输出…",

  // ---- Phase 20: GitRunningPanel chrome ----
  "sync.git.success": "Git 拉取成功",
  "sync.git.failed": "Git 拉取失败",
  "sync.git.unknownError": "未知错误",
  "sync.git.back": "返回空闲",
  "sync.git.cancel": "取消拉取",
  // Phase 26 (26-03, UI-SPEC §10): canonical Git running/log chrome.
  "sync.git.runningTitle": "正在拉取 UnrealEngine",
  "sync.git.logTitle": "Git 输出",

  // ---- Phase 20: SyncDashboard header + tabs ----
  "sync.dash.workspace": "工作区",
  "sync.dash.noWorkspace": "未选择工作区",
  "sync.dash.stream": "Stream",
  "sync.dash.p4Client": "P4 client",
  "sync.dash.git": "Git",
  "sync.dash.gitChecking": "检查中…",
  "sync.dash.gitDetached": "detached",
  "sync.dash.gitUnavailable": "不可用",
  "sync.dash.classicClient": "classic client",
  "sync.tab.sync": "同步",
  "sync.tab.history": "历史",
  "sync.tab.health": "健康",

  // ---- Phase 20: SettingsDialog proxy-status residue (SWEEP-04 exception) ----
  "settings.proxy.reachable": "✓ 代理可达 GitHub",
  "settings.proxy.reachableWithNote": "✓ 代理可达 GitHub（{note}）",
  "settings.proxy.refused": "✗ 代理不可达：Clash 未在 {port} 监听",
  "settings.proxy.timeout":
    "✗ 代理可达但 GitHub 通不过：检查 Clash 规则是否放行 github.com",
  "settings.proxy.updateAvailable": "有新版本",
  "settings.proxy.error": "✗ {message}",
  "settings.proxy.credentials": "不能保存或测试包含用户名或密码的代理地址，请使用不含凭据的本地代理。",

  // ---- Phase 21: WorkspaceForm ----
  "workspace.form.title": "添加工作区",
  "workspace.form.submit": "添加工作区",
  "workspace.form.dismiss": "不添加工作区",
  "workspace.form.description":
    "将本地 Unreal Engine 项目连接到其 Perforce 工作区。",
  "workspace.form.name": "名称",
  "workspace.form.namePlaceholder": "我的工作区",
  "workspace.form.rootPath": "根路径",
  "workspace.form.rootPathPlaceholder": "E:\\UnrealProject",
  "workspace.form.browse": "浏览文件夹",
  "workspace.form.projectDir": "项目目录",
  "workspace.form.projectDirPlaceholder": "MyGame",
  "workspace.form.projectDirHint":
    "根路径下的游戏项目子目录（例如 UnrealEngine/ 旁边的文件夹）。",
  "workspace.form.p4Client": "P4 Client",
  "workspace.form.p4ClientPlaceholder": "my_client_name",
  "workspace.form.p4User": "P4 User",
  "workspace.form.p4UserPlaceholder": "username",
  "workspace.form.error.name": "名称为必填",
  "workspace.form.error.rootPath": "根路径为必填",
  "workspace.form.error.projectDir": "项目目录为必填",
  "workspace.form.error.p4Client": "P4 Client 为必填",
  "workspace.form.error.p4User": "P4 User 为必填",

  // ---- Phase 21: WorkspaceItem ----
  "workspace.item.clBadge": "CL {cl}",
  "workspace.item.lastSynced": "上次同步：CL #{cl}",
  "workspace.item.neverSynced": "从未同步",
  "workspace.item.deleteAria": "删除 {name}",

  // ---- Phase 21: Sidebar workspace-section ----
  "workspace.sidebar.tagline": "Unreal 工作区同步",
  "workspace.sidebar.settingsAria": "设置",
  "workspace.sidebar.title": "工作区",
  "workspace.sidebar.add": "添加工作区",
  "workspace.sidebar.perforceReady": "Perforce 就绪",
  "workspace.sidebar.connectedAria": "已连接",

  // ---- Phase 25: Persistent workspace header ----
  "workspace.header.current": "当前工作区",
  "workspace.header.showMetadata": "查看 Stream 与 P4 Client",
  "workspace.header.gitUnavailableHelp":
    "无法读取 Git 标识。请检查此工作区的 Git 仓库和配置。",

  // ---- Phase 21: Workspace empty CTA ----
  "workspace.empty.title": "暂无工作区",
  "workspace.empty.add": "添加工作区",

  // ---- Phase 21: HistoryTab ----
  "history.rollback": "回滚历史",
  "history.rollback.disabledTitle": "同步进行中无法回滚",
  "history.loading": "正在加载历史…",
  "history.empty.title": "暂无同步历史",
  "history.empty.body": "完成的同步会显示在这里。",
  "history.clBadge": "CL #{cl}",
  "history.files": "{n} 个文件",
  // ---- Phase 27: History scan-table chrome ----
  "history.title": "同步历史",
  "history.subtitle": "此工作区已完成的项目同步记录",
  "history.columns.changelist": "Changelist",
  "history.columns.time": "同步时间",
  "history.columns.duration": "耗时",
  "history.columns.files": "文件数",

  // ---- Phase 21: RollbackDialog ----
  "history.rollback.dialogTitle": "回滚到 CL",
  "history.rollback.confirmTitle": "确认回滚",
  // ---- Phase 27: Rollback confirm chrome ----
  "history.rollback.confirmSubtitle": "请确认要恢复的项目版本。",
  "history.rollback.dialogDesc": "从服务器选择要同步到的 CL。",
  "history.rollback.confirmBody":
    "工作区将同步到 CL #{cl}。当前版本上未同步的文件会被覆盖。请先关闭 UE 编辑器。",
  "history.rollback.selected": "已选择：CL #{cl}",
  "history.rollback.rollingBack": "正在回滚…",
  "history.rollback.toCl": "回滚到 CL #{cl}",
  "history.rollback.dismiss": "保持当前 CL",
  "history.rollback.loadError": "无法加载 CL 列表。请检查 P4 连接后重试。",
  "history.rollback.retry": "重新加载",
  "history.rollback.loadingMore": "正在加载 CL 列表…",
  "history.rollback.noMore": "没有更多 CL",
  "history.rollback.empty": "此 Client 上没有可回滚的 CL。",

  // ---- Phase 22: remaining settings.* + layout.* (SWEEP-03) ----
  "settings.title": "设置",
  "settings.title.workspace": "工作区设置",
  "settings.description": "诊断与日志导出",
  "settings.description.workspace": "配置 {name} 的同步选项",
  "settings.startup.title": "启动",
  "settings.startup.description":
    "下次 Windows 登录时隐藏到托盘启动。请在已安装的应用中开启，以便启动项指向正式版 exe。",
  "settings.startup.launch": "随 Windows 登录启动",
  "settings.startup.error": "✗ {message}",
  "settings.logs.title": "日志",
  "settings.logs.resolving": "正在解析…",
  "settings.logs.pathAria": "当前日志文件路径",
  "settings.logs.openFolder": "打开日志文件夹",
  "settings.logs.export": "导出日志",
  "settings.logs.exported": "已导出到 {dest}",
  "settings.logs.error": "✗ {message}",
  "settings.network.title": "网络",
  "settings.network.description":
    "将自动更新的 GitHub 流量经此代理转发（例如本地 Clash mixed-port）。关闭则直连。",
  "settings.network.enable": "为自动更新启用代理",
  "settings.network.urlAria": "代理 URL",
  "settings.network.saveUrl": "保存 URL",
  "settings.network.test": "测试连接",
  "settings.network.testing": "测试中…",
  "settings.network.saved": "已保存",
  "settings.threads.label": "并行线程",
  "settings.threads.hint": "设为 1 可关闭并行同步",
  "settings.behind.label": "落后检查间隔（分钟）",
  "settings.behind.hint": "空闲视图检查 Perforce 待同步文件的频率",
  "settings.exclusions.title": "排除路径",
  "settings.exclusions.relativeTo": "路径相对于 {projectDir}/",
  "settings.exclusions.projectFallback": "项目目录",
  "settings.exclusions.removeAria": "移除 {path}",
  "settings.exclusions.inputAria": "排除路径",
  "settings.exclusions.placeholder": "添加路径…",
  "settings.exclusions.add": "添加路径",
  "settings.exclusions.error.empty": "路径不能为空",
  "settings.exclusions.error.invalid": "路径无效",
  "settings.exclusions.error.duplicate": "路径已存在",
  "settings.exclusions.missing.one": "找不到路径：{paths}",
  "settings.exclusions.missing.other": "找不到路径：{paths}",
  "settings.cancel": "不保存并关闭",
  "settings.save": "保存工作区设置",

  // ---- Phase 28: settings scope chrome (DLG-01) ----
  "settings.tab.workspace": "此工作区",
  "settings.tab.app": "应用设置",
  "settings.tabsAria": "设置范围",
  "settings.persist.immediate": "即时保存",
  "settings.scope.app": "应用全局选项",
  "layout.resizeAria": "调整侧栏宽度",
  "layout.changelog.title": "v{version} 更新日志",
  "layout.changelog.description": "本构建包含的近期更改。",
  "layout.changelog.empty": "无 git 历史",
  "layout.updater.availableTitle": "v{version} 可用 — 点击安装",
  "layout.updater.checkAria": "检查更新",
  "layout.updater.askTitle": "发现更新",
  "layout.updater.askBody": "版本 {version} 可用。现在安装？应用将重启。",
  "layout.updater.askYes": "是",
  "layout.updater.askNo": "否",

  // ---- Phase 24: titlebar chrome (SHELL-02) ----
  "titlebar.minimize": "最小化",
  "titlebar.maximize": "最大化",
  "titlebar.close": "关闭",
};

export default zh;
