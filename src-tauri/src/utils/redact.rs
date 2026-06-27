//! Redaction net for the file-target log pipeline (Phase 10, D-05 audited boundary).
//!
//! The single `redact()` entry point is the ONLY layer that protects the
//! Display / error-chain / panic / `io::Error` paths — those render to a
//! message string BEFORE any struct is involved, so only the net catches
//! them. The panic hook (`lib.rs:31-44`) routes `PANIC at {loc}: {msg}\n{bt}`
//! through `log::error!` -> `file_formatter` -> `redact()`, so backtrace
//! paths (`C:\Users\<you>\...\src\lib.rs`) are caught here.
//!
//! Design guarantees:
//! - **Zero-alloc fast path** — `redact()` returns `Cow::Borrowed(s)` when no
//!   pattern matches. Critical because it runs on every file-target line.
//! - **`Vec<(Regex, &'static str)>`** compiled once via `std::sync::OnceLock`
//!   and iterated with per-pattern `replace_all`. `RegexSet` cannot replace
//!   (verified `regex-1.12.3/src/regexset/string.rs:210,287`) — it only
//!   reports *which* patterns matched.
//! - **Cow reborrow loop** — `match cur { Borrowed(b) => re.replace_all(b, tok),
//!   Owned(ref o) => re.replace_all(o, tok) }`. Never `.into_owned()` inside
//!   the loop (destroys the fast path).
//! - **`%USERNAME%` injection (D-03 fail-open mitigation)** — the Windows
//!   username is read once from `std::env::var("USERNAME")` and added as an
//!   extra `<USER>` row. This catches the literal username in non-`Users`
//!   path positions (`E:\workspaces\<you>\`), which the `[A-Z]:\\Users\\`
//!   anchored pattern cannot reach (research A1).

use std::borrow::Cow;
use std::sync::OnceLock;

use regex::Regex;

use crate::models::workspace::WorkspaceConfig;

/// Compile-once redaction catalog: (pattern, literal replacement token).
///
/// Each pattern is independently unit-testable (SC#1). Order matters only when
/// one pattern's output could feed another's input — audit on edit. Sourced
/// verbatim from `10-RESEARCH.md` Pattern 1 (lines 232-261), verified against
/// `regex-1.12.3` crate source.
static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();

fn patterns() -> &'static [(Regex, &'static str)] {
    PATTERNS.get_or_init(|| {
        vec![
            // --- D-03: filesystem paths, preserve-tail (fail-open; SC#2 backs this) ---
            // Home-prefix on any drive: C:\Users\<you>\  ->  <PATH>\
            // Multi-drive so D:\Users\ and E:\Users\ are also masked.
            (Regex::new(r#"[A-Z]:\\Users\\[^\\]+\\"#).unwrap(), r#"<PATH>\"#),
            // UE personal-content folder: Developers/<you>/  ->  Developers/<DEVELOPER>/
            (Regex::new(r"(?i)Developers/[^/]+/").unwrap(), r"Developers/<DEVELOPER>/"),
            // --- SC#1 locked set ---
            // Depot path (whole-mask per D-06 default; p4 sync output uses depot form).
            (Regex::new(r"//FYGame/\S*").unwrap(), r"<DEPOT>"),
            // P4PORT spec (absorbs host per D-01): ssl:host:1666, tcp:host:1666, host:1666.
            (Regex::new(r"(?i)P4PORT=\S*").unwrap(), r"P4PORT=<P4PORT>"),
            (Regex::new(r"\bssl:[A-Za-z0-9._-]+:\d+\b").unwrap(), r"<P4PORT>"),
            (Regex::new(r"\btcp:[A-Za-z0-9._-]+:\d+\b").unwrap(), r"<P4PORT>"),
            // P4USER / P4PASSWD / P4CLIENT tagged values.
            (Regex::new(r"(?i)P4USER=\S+").unwrap(), r"P4USER=<P4USER>"),
            (Regex::new(r"(?i)P4PASSWD=\S+").unwrap(), r"P4PASSWD=<P4PASSWD>"),
            (Regex::new(r"(?i)P4CLIENT=\S+").unwrap(), r"P4CLIENT=<P4CLIENT>"),
            // --- D-01 additions ---
            // Git remote URL creds (D-02): strip user:pass@, keep host + path.
            // MUST run before the email pattern so `user:token@host.com` is
            // stripped before `token@host.com` matches the email regex.
            (Regex::new(r"https://[A-Za-z0-9._-]+:[^\s/@]+@").unwrap(), r"https://<CRED>@"),
            // git@ ssh-style creds (D-02). Same ordering reason as above.
            (Regex::new(r"\bgit@[A-Za-z0-9._-]+:").unwrap(), r"<CRED>"),
            // UNC host (\\machine\share). Replacement keeps one trailing slash
            // so the share name survives (non-identifying).
            (Regex::new(r"\\\\[A-Za-z0-9._-]+\\").unwrap(), r"\\<HOST>\"),
            // COMPUTERNAME shape (DESKTOP-xxxx) — labeled-value form avoids false positives.
            (Regex::new(r"(?i)COMPUTERNAME=\S+").unwrap(), r"COMPUTERNAME=<HOST>"),
            // p4 auth ticket (hex token, 32+ chars typical).
            (Regex::new(r"\b[A-Fa-f0-9]{32,}\b").unwrap(), r"<TICKET>"),
            // Email (fail-safe over-mask is the correct failure mode here).
            // Runs AFTER the git-creds patterns so credential URLs are stripped
            // before the bare-email shape is matched.
            (Regex::new(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b").unwrap(), r"<EMAIL>"),
        ]
    })
}

/// Optional `%USERNAME%`-injected row (D-03 fail-open mitigation).
///
/// Reads `std::env::var("USERNAME")` once via `get_or_init`. If the var is set
/// AND non-empty, compiles `r"(?i)\b<escaped_username>\b"` (using
/// `regex::escape` so metacharacters in usernames don't corrupt the pattern)
/// and returns `Some((regex, "<USER>"))`. If unset/empty, returns `None`
/// (graceful — research A1: extremely unlikely on Windows).
static USERNAME_PATTERN: OnceLock<Option<(Regex, &'static str)>> = OnceLock::new();

fn username_pattern() -> Option<&'static (Regex, &'static str)> {
    USERNAME_PATTERN
        .get_or_init(|| {
            // D-03 fail-open mitigation: catch the literal Windows username in
            // non-`Users` path positions (E:\workspaces\<you>\). Decoupled from
            // WorkspaceConfig.p4_user because the OS username is what appears
            // in filesystem paths.
            std::env::var("USERNAME")
                .ok()
                .filter(|u| !u.is_empty())
                .and_then(|username| {
                    let pattern = format!(r"(?i)\b{}\b", regex::escape(&username));
                    Regex::new(&pattern).ok().map(|re| (re, "<USER>"))
                })
        })
        .as_ref()
}

/// The audited redaction boundary (D-05). Returns `Cow::Borrowed(s)` when no
/// pattern matches (zero-alloc fast path — the common case for log lines).
/// Called once per file-target line inside `file_formatter`.
///
/// The `%USERNAME%` row (if `USERNAME` env var is set) is applied AFTER the
/// static catalog — it catches the literal username anywhere it survives the
/// static patterns (e.g. `E:\workspaces\<you>\FYGame\`).
pub fn redact<'a>(s: &'a str) -> Cow<'a, str> {
    let user_row = username_pattern().map(|row| (&row.0, row.1));
    redact_with_username_row(s, user_row)
}

/// Internal: apply the static catalog, then an optional username row.
///
/// Factored so the SC#5 path-variant test can inject a deterministic username
/// pattern (the host's `USERNAME` env var is whatever the operator's machine
/// is set to — almost never "alice" — so the public `redact()` cannot itself
/// be asserted against `E:\workspaces\alice\...` without env coupling).
fn redact_with_username_row<'a>(
    s: &'a str,
    user_row: Option<(&Regex, &str)>,
) -> Cow<'a, str> {
    // replace_all returns Cow::Borrowed(haystack) when no match
    // (regex-1.12.3/src/regex/string.rs:924-925). To keep the zero-alloc fast
    // path we must avoid .into_owned() while `cur` is still Cow::Borrowed; once
    // a prior pattern has promoted `cur` to Cow::Owned, subsequent replace_all
    // calls operate on that owned buffer and may return either variant. We
    // thread the borrow through via a helper so the borrow checker can see the
    // lifetimes line up (10-RESEARCH.md Pitfall 4 — Cow lifetime churn).
    let mut cur: Cow<'a, str> = Cow::Borrowed(s);
    for (re, tok) in patterns() {
        cur = apply_one(cur, re, tok);
    }
    if let Some((re, tok)) = user_row {
        cur = apply_one(cur, re, tok);
    }
    cur
}

/// Apply a single (Regex, token) pair to `cur`, preserving the Cow fast path.
///
/// When `cur` is `Cow::Borrowed`, `replace_all` returns `Cow::Borrowed` on
/// no-match (zero alloc — the `'a` lifetime threads straight through). When
/// `cur` is `Cow::Owned`, we own the buffer, so any return — `Borrowed` (no
/// match) or `Owned` (match) — is safe to reassign; the function takes `cur`
/// by value so the owned buffer moves in and is not borrowed across the call.
fn apply_one<'a>(cur: Cow<'a, str>, re: &Regex, tok: &str) -> Cow<'a, str> {
    match cur {
        Cow::Borrowed(b) => re.replace_all(b, tok),
        // We own the String; replace_all may return Borrowed pointing into it
        // (no match) or Owned (match). Either way the borrow ties to data we
        // moved in, so repackage into a fresh Cow with the right lifetime.
        Cow::Owned(o) => match re.replace_all(&o, tok) {
            Cow::Borrowed(_) => Cow::Owned(o),
            Cow::Owned(replaced) => Cow::Owned(replaced),
        },
    }
}

// ---------------------------------------------------------------------------
// SC#2 test-fixture surface (consumed by Wave 2 struct-Debug non-leak tests).
// ---------------------------------------------------------------------------

/// Representative username for SC#2 assertions. The username "alice" and p4
/// identities are fake; SC#2 asserts NONE of them appear in
/// `format!("{:?}", fixture)` or in `redact()` output for any path variant.
pub const FIXTURE_USERNAME: &str = "alice";
pub const FIXTURE_P4_CLIENT: &str = "alice-laptop-fygame";
pub const FIXTURE_P4_USER: &str = "alice";

/// A `WorkspaceConfig` populated with the fake identity. Used by Wave 2 SC#2
/// tests via `crate::utils::redact::test_workspace_fixture()` to assert the
/// manual `Debug` impl does not leak username/p4_client/p4_user/root_path.
pub fn test_workspace_fixture() -> WorkspaceConfig {
    WorkspaceConfig {
        id: "ws-test".into(),
        name: "Alice's FYGame".into(),
        root_path: r"C:\Users\alice\workspaces\FYGame".into(),
        project_dir: "MyGame".into(),
        p4_client: FIXTURE_P4_CLIENT.into(),
        p4_user: FIXTURE_P4_USER.into(),
        last_sync_cl: Some("310771".into()),
        last_sync_time: Some("2026-06-27T10:00:00".into()),
        last_sync_file_count: Some(226726),
        parallel_threads: 8,
        exclusions: vec!["Binaries".into(), "Content/Developers".into()],
        interval_minutes: 60,
    }
}

/// Path variants for the D-03 fail-open backstop. SC#5 asserts the fixture
/// username (`alice`) appears in NONE of these after `redact()`. Covers
/// Users home, non-Users drives, the UE Developers segment, and depot forms.
pub const PATH_VARIANTS: &[&str] = &[
    // Users home on the default drive.
    r"C:\Users\alice\workspaces\FYGame\Content\Maps\Foo.uasset",
    // Non-Users drive (the D-03 fail-open case the %USERNAME% row mitigates).
    r"E:\workspaces\alice\FYGame\Content\Maps\Foo.uasset",
    // Another non-Users drive.
    r"D:\dev\alice\FYGame\Source\MyGame\MyGame.build.cs",
    // UE personal-content folder (Developers/<segment>/).
    r"FYGame/Content/Developers/alice/Maps/Test.umap",
    // Depot form with a Developers segment.
    r"//FYGame/Content/Developers/alice/Maps/Test.umap",
    // Depot form with no username (whole-masked, must not regress).
    r"//FYGame/Main/Content/Maps/Foo.uasset",
];

#[cfg(test)]
mod tests {
    use super::*;

    // ---- SC#1: filesystem paths (preserve-tail per D-03) ----

    #[test]
    fn redact_masks_users_home_path_to_path_token() {
        // D-03 preserve-tail: the identifying prefix is masked, the
        // non-identifying game-relative remainder survives.
        assert_eq!(
            redact(r"C:\Users\alice\workspaces\FYGame"),
            r"<PATH>\workspaces\FYGame"
        );
    }

    #[test]
    fn redact_masks_users_home_on_non_c_drive() {
        // Multi-drive: the [A-Z]:\\Users\\ anchor must catch any drive, not just C:.
        assert_eq!(
            redact(r"D:\Users\bob\workspaces\FYGame"),
            r"<PATH>\workspaces\FYGame"
        );
    }

    // ---- SC#1: Developers segment (D-03 UE personal-content folder) ----

    #[test]
    fn redact_preserves_developers_segment_mask() {
        // The UE personal-content folder is the one game-relative position
        // where a username appears in p4/depot output.
        assert_eq!(
            redact("FYGame/Content/Developers/alice/Maps/Foo.umap"),
            "FYGame/Content/Developers/<DEVELOPER>/Maps/Foo.umap"
        );
    }

    // ---- SC#1: depot path (whole-mask per D-06 default) ----

    #[test]
    fn redact_masks_depot_path_to_depot_token() {
        assert_eq!(
            redact("//FYGame/Main/Content/Maps/Foo.uasset"),
            "<DEPOT>"
        );
    }

    // ---- SC#1: P4PORT (absorbs host per D-01) ----

    #[test]
    fn redact_masks_p4port_ssl_spec_to_p4port_token() {
        assert_eq!(redact("ssl:perforce-ssl:1666"), "<P4PORT>");
    }

    #[test]
    fn redact_masks_p4port_tcp_spec_to_p4port_token() {
        assert_eq!(redact("tcp:perforce-tcp:1666"), "<P4PORT>");
    }

    #[test]
    fn redact_masks_p4port_tagged_value_to_p4port_token() {
        assert_eq!(redact("P4PORT=ssl:host:1666"), "P4PORT=<P4PORT>");
    }

    #[test]
    fn redact_masks_p4port_tagged_value_case_insensitive() {
        // The (?i) flag catches the lowercase env-var spelling; the literal
        // replacement token is always uppercase `P4PORT=<P4PORT>` regardless
        // of the input case (the token is a fixed string, not a backref).
        assert_eq!(redact("p4port=host:1666"), "P4PORT=<P4PORT>");
    }

    // ---- SC#1: P4USER / P4PASSWD / P4CLIENT tagged values ----

    #[test]
    fn redact_masks_p4user_tagged_value() {
        assert_eq!(redact("P4USER=alice"), "P4USER=<P4USER>");
    }

    #[test]
    fn redact_masks_p4passwd_tagged_value() {
        assert_eq!(redact("P4PASSWD=s3cret-token"), "P4PASSWD=<P4PASSWD>");
    }

    #[test]
    fn redact_masks_p4client_tagged_value() {
        assert_eq!(redact("P4CLIENT=alice-laptop"), "P4CLIENT=<P4CLIENT>");
    }

    // ---- SC#1: email ----

    #[test]
    fn redact_masks_email_to_email_token() {
        assert_eq!(redact("contact: alice@example.com"), "contact: <EMAIL>");
    }

    // ---- SC#1: git remote creds (D-02 strip-creds-keep-URL) ----

    #[test]
    fn redact_strips_git_url_creds_keeps_url() {
        // D-02: strip only the credential portion (user:pass@), keep host + path
        // so the diagnostic "which repo did UE git pull target" signal survives.
        assert_eq!(
            redact("https://alice:ghp_token@github.com/EpicGames/UnrealEngine.git"),
            "https://<CRED>@github.com/EpicGames/UnrealEngine.git"
        );
    }

    #[test]
    fn redact_masks_git_ssh_style_creds() {
        // git@host: ssh-style creds (D-02 sibling pattern).
        assert_eq!(
            redact("git@github.com:EpicGames/UnrealEngine.git"),
            "<CRED>EpicGames/UnrealEngine.git"
        );
    }

    // ---- SC#1: machine identity (UNC + COMPUTERNAME) ----

    #[test]
    fn redact_masks_unc_host_to_host_token() {
        // \\machine\share -> \\<HOST>\share (the share path tail is kept — non-identifying).
        assert_eq!(
            redact(r"\\buildfarm\share\FYGame"),
            r"\\<HOST>\share\FYGame"
        );
    }

    #[test]
    fn redact_masks_computername_tagged_value() {
        assert_eq!(
            redact("COMPUTERNAME=DESKTOP-ALICE-PC"),
            "COMPUTERNAME=<HOST>"
        );
    }

    // ---- SC#1: p4 auth ticket ----

    #[test]
    fn redact_masks_hex_ticket_to_ticket_token() {
        // p4 auth tickets are hex tokens; 32+ hex chars are masked. The leading
        // space keeps the \b word-boundary honest.
        assert_eq!(
            redact("ticket: ABCDEF0123456789ABCDEF0123456789"),
            "ticket: <TICKET>"
        );
    }

    // ---- Cow fast path (zero-alloc on no-match) ----

    #[test]
    fn redact_no_match_returns_borrowed_zero_alloc() {
        // A clean business line: no pattern fires, so replace_all must return
        // Cow::Borrowed(haystack) (regex src :924-925). This pins the
        // fast-path invariant that makes redact() cheap per file-target line.
        let clean = "[sync] step=p4Sync starting";
        match redact(clean) {
            Cow::Borrowed(b) => assert_eq!(b, clean),
            Cow::Owned(_) => panic!(
                "redact() must return Cow::Borrowed on no-match (zero-alloc fast path)"
            ),
        }
    }

    // ---- SC#5: D-03 fail-open backstop (path variants) ----

    #[test]
    fn redact_path_variants_do_not_leak_username() {
        // The operator's D-03 preserve-tail choice is fail-open by construction.
        // The %USERNAME% row (plus the multi-drive Users anchor and Developers
        // segment mask) is the mitigation. This test is the acceptance gate:
        // across ALL path shapes, the fixture username must not survive.
        //
        // Why this uses redact_with_username_row and not the public redact():
        // the public function caches the host's %USERNAME% in a process-global
        // OnceLock, so its behavior depends on the operator's machine. To make
        // the SC#5 gate deterministic in CI, we inject the fixture username
        // "alice" explicitly here via the internal seam — exercising the exact
        // code path production uses (static catalog -> username row) but with a
        // known username. This mirrors how the production redact() builds and
        // applies the username pattern (regex::escape + word boundaries).
        let user_re = Regex::new(&format!(r"(?i)\b{}\b", regex::escape(FIXTURE_USERNAME)))
            .expect("fixture username must compile as a regex");
        for variant in PATH_VARIANTS {
            let masked = redact_with_username_row(variant, Some((&user_re, "<USER>")));
            assert!(
                !masked.contains(FIXTURE_USERNAME),
                "D-03 fail-open leaked username in variant {variant:?} -> {masked:?}"
            );
        }
    }

    #[test]
    fn redact_non_users_drive_caught_by_username_row_only() {
        // Targeted regression: the static catalog alone CANNOT catch a username
        // in a non-Users drive position (E:\workspaces\<you>\). This pins the
        // fact that the username row is load-bearing for D-03, not redundant.
        let user_re = Regex::new(&format!(r"(?i)\b{}\b", regex::escape(FIXTURE_USERNAME)))
            .expect("fixture username must compile");
        let variant = r"E:\workspaces\alice\FYGame\Content\Maps\Foo.uasset";
        // Without the username row: "alice" leaks (the static patterns don't fire).
        let without = redact_with_username_row(variant, None);
        assert!(
            without.contains(FIXTURE_USERNAME),
            "precondition: static catalog must NOT catch non-Users username (got {without:?})"
        );
        // With the username row: "alice" is masked.
        let with = redact_with_username_row(variant, Some((&user_re, "<USER>")));
        assert!(
            !with.contains(FIXTURE_USERNAME),
            "username row must catch non-Users username (got {with:?})"
        );
    }

    // ---- test_workspace_fixture sanity ----

    #[test]
    fn test_workspace_fixture_populates_identity_fields() {
        // Sanity: the fixture carries the fake identity so Wave 2 SC#2 tests
        // have a concrete object to assert against.
        let ws = test_workspace_fixture();
        assert_eq!(ws.name, "Alice's FYGame");
        assert_eq!(ws.p4_client, FIXTURE_P4_CLIENT);
        assert_eq!(ws.p4_user, FIXTURE_P4_USER);
        assert!(ws.root_path.contains(FIXTURE_USERNAME));
    }
}
