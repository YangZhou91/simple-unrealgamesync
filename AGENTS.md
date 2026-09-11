<!-- GSD:project-start source:PROJECT.md -->
## Project

**Simple UnrealGameSync**

一个 Tauri 桌面客户端，用于执行 Unreal Engine 源码版游戏项目的 Perforce 同步更新。替代 PowerShell 脚本，提供 GUI 界面、实时进度展示、多工作区管理和历史记录回滚能力。面向个人使用，但本地有多个 P4 workspace 需要切换。

**Core Value:** 一键完成游戏项目的 Perforce 同步更新，包括自动关闭 UE 编辑器、清理 Developers 目录、执行 p4 sync、运行 GenerateProjectFiles 的完整流程。

### Constraints

- **Tech Stack**: Tauri 2.x + Web 前端 (React/Vue) — 用户选择的技术栈
- **Platform**: Windows only — UE 开发环境主要在 Windows
- **Runtime**: 需要系统已安装 p4 命令行客户端
- **Workspace**: 必须在包含「项目子目录 + UnrealEngine/」结构的工作区根目录执行；项目子目录名可在添加工作区时配置
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Recommended Stack
### Core Framework
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| **Tauri** | 2.11.x | Desktop app framework (Rust backend + webview frontend) | Only serious lightweight alternative to Electron. Tauri 2 stable since Oct 2024, now at v2.11.2. Uses system webview (no bundled browser), small binary size, Rust for backend logic. Windows-only requirement makes Tauri ideal -- no cross-platform webview quirks to worry about. | HIGH |
| **Rust** | 1.82+ (MSRV 1.77.2 for Tauri plugins) | Backend language | Required by Tauri. Excellent for CLI process orchestration (tokio async), zero-cost abstractions, strong type system prevents runtime errors. MSRV 1.77.2 enforced by all Tauri plugins. | HIGH |
### Frontend
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| **React** | 19.x | UI component framework | PROJECT.md specifies React/Vue as user's choice. React 19 stable since Dec 2024, now at v19.2.x. Largest ecosystem of component libraries. Hooks model fits well with Tauri's invoke/Channel pattern (custom hooks for `useSync`, `useWorkspaces`). React 19's compiler optimizations reduce re-render overhead for streaming log viewers. | HIGH |
| **TypeScript** | 5.7+ | Type safety for frontend | Standard for any non-trivial React app. Enables typed Tauri invoke wrappers and Channel message types that match Rust structs. | HIGH |
| **Vite** | 6.x | Frontend build tool and dev server | Tauri's officially recommended bundler. Vite 6 is the safe choice -- Vite 7/8 are too new (released mid-2025) and have no validated Tauri compatibility. Vite 6 has proven stability with Tauri 2.x. Do NOT use Vite 7+ until Tauri officially documents compatibility. | HIGH |
| **Tailwind CSS** | 4.x | Utility-first CSS framework | v4 released Jan 2025 with CSS-first configuration (no tailwind.config.js needed). Pairs well with shadcn/ui. Vite plugin integration is native. | HIGH |
| **shadcn/ui** | latest (CLI: `npx shadcn@latest init`) | Component library | Copy-paste component library built on Radix UI + Tailwind. Not a dependency -- you own the code. Provides Progress, Table, Dialog, Command, ScrollArea -- all needed for this app. Strong Tauri + shadcn community (boilerplates exist). Better than MUI/Ant Design for desktop apps because components are unstyled by default and adapt to desktop aesthetics. | HIGH |
### Rust Backend Libraries
| Library | Version | Purpose | Why | Confidence |
|---------|---------|---------|-----|------------|
| **tokio** | 1.x (features: `process`, `io-util`, `rt-multi-thread`) | Async runtime for process spawning | Tauri 2 uses tokio internally. Required for `tokio::process::Command` to spawn p4/cli processes asynchronously without blocking the UI thread. `BufReader::lines()` on child stdout gives line-by-line streaming. | HIGH |
| **serde** + **serde_json** | 1.x | Serialization for IPC | Required for all data crossing the Tauri IPC boundary. Every struct sent to/from frontend needs `#[derive(Serialize, Deserialize)]`. | HIGH |
| **thiserror** | 2.x | Error type derivation | Idiomatic Rust error handling. Derive `Error` for custom error types that implement `Serialize` (required by Tauri commands). Cleaner than manual `map_err(\|e\| e.to_string())` everywhere. | HIGH |
### Tauri Plugins (Rust + JS bindings)
| Plugin | Crate Version | NPM Version | Purpose | Why | Confidence |
|--------|---------------|-------------|---------|-----|------------|
| **tauri-plugin-shell** | 2.3.x | 2.3.4 | Shell access for sidecars | Required by the shell plugin permission system even if you spawn processes from Rust directly. Register it for capability permissions. Do NOT use `tauri-plugin-shellx` -- it bypasses Tauri's security model. | HIGH |
| **tauri-plugin-store** | 2.4.x | 2.2.0 | Persistent JSON key-value store | For workspace configs and user settings (exclusion rules, thread count). Simple key-value with auto-save. `LazyStore` API is convenient. Do NOT use this for sync history -- use SQL plugin instead. | HIGH |
| **tauri-plugin-sql** | 2.4.x | 2.2.x | SQLite database for structured data | For sync history records (changelist, timestamp, file list, workspace). Append-heavy, needs querying by date/workspace/CL. SQLite is the right tool here, not JSON. Feature flag: `sqlite`. | HIGH |
| **tauri-plugin-log** | 2.8.x | 2.4.x | Structured logging | Rust-side logging for debugging. Log to file + console. Useful for diagnosing process spawning issues in production. | MEDIUM |
| **tauri-plugin-dialog** | 2.x | 2.x | Native file/folder picker dialogs | For selecting workspace root paths. Uses Windows native folder picker. Better than typing paths manually. | HIGH |
| **tauri-plugin-fs** | 2.x | 2.x | File system access | For reading workspace directory structure, cleaning Developers directory. Can use alongside direct `tokio::fs` in Rust. | HIGH |
| **tauri-plugin-process** | 2.x | 2.x | Current process info | Access to app version, platform info. Useful for diagnostics display. | LOW |
### Frontend Libraries
| Library | Version | Purpose | When to Use | Confidence |
|---------|---------|---------|-------------|------------|
| **@tauri-apps/api** | 2.11.x | Core Tauri JS bindings (`invoke`, `Channel`, `listen`) | Always. This is the main IPC bridge. | HIGH |
| **@tauri-apps/plugin-shell** | 2.3.x | Shell plugin JS bindings | For registering shell permissions. Process orchestration happens in Rust. | HIGH |
| **@tauri-apps/plugin-store** | 2.2.x | Store plugin JS bindings | For workspace config CRUD from frontend. | HIGH |
| **@tauri-apps/plugin-sql** | 2.2.x | SQL plugin JS bindings | For history queries from frontend. | HIGH |
| **@tauri-apps/plugin-dialog** | 2.x | Dialog plugin JS bindings | For folder picker when adding workspaces. | HIGH |
| **react-virtuoso** | 4.x | Virtualized scrolling for large lists | Essential for the LogViewer component. Streaming thousands of p4 sync lines into a DOM will lag without virtualization. | HIGH |
| **lucide-react** | latest | Icon library | Fits shadcn/ui's default icon set. Lightweight tree-shakeable SVG icons. | HIGH |
### Development Tools
| Tool | Version | Purpose | Why | Confidence |
|------|---------|---------|-----|------------|
| **@tauri-apps/cli** | 2.x | Tauri CLI (`tauri dev`, `tauri build`) | Required for development workflow. | HIGH |
| **@vitejs/plugin-react** | 4.x | Vite React support (Fast Refresh) | Standard Vite + React integration. | HIGH |
## What NOT to Use and Why
| Rejected | Reason |
|----------|--------|
| **Electron** | Against project constraints. Tauri chosen for lightweight binary size and Rust backend. Electron ships a full Chromium (~150MB). Tauri apps are ~5-10MB. |
| **tauri-plugin-shellx** | Community plugin that bypasses Tauri's security scope system. "Execute any command freely" defeats the permission model. Use official `tauri-plugin-shell` with proper capability configuration. |
| **Vite 7/8** | Too new (released mid-2025). No validated Tauri 2 compatibility. Vite 6 is proven stable. Upgrade later after Tauri officially documents support. |
| **Vue / Svelte / Solid** | PROJECT.md specifies React/Vue as options. React chosen for its ecosystem size and shadcn/ui compatibility. Vue would also work but has fewer shadcn/ui resources. Svelte/Solid are valid but have smaller ecosystems for desktop-style component libraries. |
| **MUI / Ant Design** | Designed for web apps, not desktop. Heavy CSS overrides needed for desktop aesthetics. shadcn/ui is unstyled and adapts naturally. MUI's runtime CSS-in-JS adds overhead that's unnecessary for a desktop app. |
| **SQLite via direct Rust crate (rusqlite)** | Use `tauri-plugin-sql` instead. It handles native plugin registration, capability permissions, and provides both Rust and JS APIs. Direct rusqlite would bypass Tauri's IPC and permission system. |
| **SQLite for workspace config** | Overkill. Workspace configs are small objects read/written as a whole. JSON Store is simpler and sufficient. Use SQLite only for append-heavy queryable data (sync history). |
| **tauri-plugin-stronghold** | Encrypted storage. Unnecessary for a personal tool with no sensitive data. P4 credentials are managed by the p4 client itself (tickets or environment), not by this app. |
| **Redux / Zustand / Jotai** | State management libraries. Unnecessary because Tauri's managed state pattern handles backend state, and React's built-in useState/useReducer handles frontend UI state. The only cross-component state is sync events, which flow through Channel subscriptions in custom hooks. |
| **React Router** | This is a single-window app with tabs/panels, not a multi-page SPA. Tab switching via React state is simpler than URL-based routing. Adding a router would add complexity for zero benefit. |
## Architecture Summary
## Installation
### Prerequisites
# Rust toolchain (1.82+ recommended)
# Node.js (18+ recommended)
# pnpm preferred for Tauri projects
### Create Project
# Scaffold Tauri 2 + React + TypeScript + Vite
### Core Dependencies
# Frontend dependencies
# Tailwind CSS v4 (Vite plugin)
# shadcn/ui
# shadcn/ui components (add as needed)
# Virtualized list for log viewer
# Icons
# Dev dependencies
### Rust Dependencies (src-tauri/Cargo.toml)
### Vite Configuration for Tailwind v4
## Version Pinning Strategy
## Key Technical Decisions
### Why tokio::process::Command, not tauri-plugin-shell from JS
### Why Channel<T>, not app.emit() for streaming
### Why Dual Storage (Store + SQLite)
- **Store (JSON):** Workspace configs, user settings, exclusion rules. Small objects, read-heavy, accessed as whole documents. Auto-save is convenient.
- **SQLite:** Sync history records. Append-heavy, grows over time, needs querying by date/workspace/CL. JSON would require loading entire file into memory for each query.
## Sources
- [Tauri 2.0 Stable Release](https://v2.tauri.app/blog/tauri20/) -- HIGH confidence, official blog
- [Tauri crate v2.11.2](https://crates.io/crates/tauri) -- HIGH confidence, verified on crates.io
- [@tauri-apps/api v2.11.0](https://www.npmjs.com/package/@tauri-apps/api) -- HIGH confidence, verified on npm
- [@tauri-apps/plugin-shell v2.3.4](https://www.npmjs.com/package/@tauri-apps/plugin-shell) -- HIGH confidence, verified on npm
- [tauri-plugin-shell v2.3.5](https://crates.io/crates/tauri-plugin-shell) -- HIGH confidence, verified on crates.io
- [tauri-plugin-store v2.4.3](https://crates.io/crates/tauri-plugin-store) -- HIGH confidence, verified on crates.io
- [tauri-plugin-sql v2.4.0](https://crates.io/crates/tauri-plugin-sql) -- HIGH confidence, verified on crates.io
- [tauri-plugin-log v2.8.0](https://crates.io/crates/tauri-plugin-log) -- HIGH confidence, verified on crates.io
- [React 19.0.0 Stable](https://react.dev/blog/2024/12/05/react-19) -- HIGH confidence, official React blog
- [Tailwind CSS v4.0](https://tailwindcss.com/blog/tailwindcss-v4) -- HIGH confidence, official Tailwind blog
- [Vite Releases](https://vite.dev/releases) -- HIGH confidence, official Vite site
- [Tauri Shell Plugin Docs](https://v2.tauri.app/plugin/shell/) -- HIGH confidence, official Tauri v2 docs
- [Tauri Store Plugin Docs](https://v2.tauri.app/plugin/store/) -- HIGH confidence, official Tauri v2 docs
- [Tauri Channel API (Calling Frontend from Rust)](https://v2.tauri.app/develop/calling-frontend/) -- HIGH confidence, official Tauri v2 docs
- [Tauri Commands (Calling Rust from Frontend)](https://v2.tauri.app/develop/calling-rust/) -- HIGH confidence, official Tauri v2 docs
- [shadcn/ui + Tauri boilerplate (Reddit)](https://www.reddit.com/r/tauri/comments/1l1y26v/i_built_a_tauri_shadcnui_boilerplate/) -- MEDIUM confidence, community example
- [SO: Live output from CLI in Tauri](https://stackoverflow.com/questions/76569466/emit-log-messages-in-real-time-from-executable-while-running-in-tauri-project) -- MEDIUM confidence, validated pattern
- [GitHub: Stream stdout from sidecar discussion](https://github.com/orgs/tauri-apps/discussions/8641) -- MEDIUM confidence, community discussion
- [Reddit: Tauri GUI wrapper for CLI spawn](https://www.reddit.com/r/tauri/comments/1rhu40d/tauri_gui_wrapper_for_claude_code_spawn_real_cli/) -- MEDIUM confidence, community example
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.Codex/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-Codex-profile` -- do not edit manually.
<!-- GSD:profile-end -->
