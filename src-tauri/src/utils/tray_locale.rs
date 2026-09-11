//! Pure tray/menu/notification string layer for Phase 18 localization.
//!
//! Modeled on `utils/time.rs`: a plain-module utility taking primitives and
//! returning primitives — ZERO Tauri imports, zero state — so the whole
//! template table is unit-testable without a Tauri handle
//! (`cargo test --lib tray_locale`).
//!
//! Copy contract: the zh/en pairs below are LOCKED by the Phase 18 UI-SPEC
//! Copywriting Contract. The brand prefix `Simple UnrealGameSync` is never
//! localized (TRAY-03): it is identical in both locales everywhere it
//! appears.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};

/// Brand string — notification title and tooltip prefix. Never localized
/// (TRAY-03): identical in both locales everywhere it appears.
pub const APP_TITLE: &str = "Simple UnrealGameSync";

/// Two-valued UI locale. Wire/store values must match `src/lib/localeSettings.ts`
/// exactly ("zh" / "en").
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
pub enum Locale {
    #[serde(rename = "zh")]
    Zh,
    #[serde(rename = "en")]
    En,
}

/// Managed Rust-side locale state (WIRE-04). `std::sync::RwLock` — the read
/// at format time is nanoseconds and the lock is never held across an await.
/// Lock via `.expect("AppLocale lock poisoned")` matching process_manager's
/// direct-lock style (threat T-18-02: accepted).
pub struct AppLocale(Arc<RwLock<Locale>>);

impl AppLocale {
    pub fn new(initial: Locale) -> Self {
        Self(Arc::new(RwLock::new(initial)))
    }

    pub fn get(&self) -> Locale {
        *self.0.read().expect("AppLocale lock poisoned")
    }

    pub fn set(&self, l: Locale) {
        *self.0.write().expect("AppLocale lock poisoned") = l;
    }
}

/// Collapse a raw system BCP-47 tag to the UI locale — verbatim port of
/// `src/main.tsx:16` (`startsWith("zh") ? zh : en`) including the None -> zh
/// default (I18N-04, commit 4868231). Divergence between the two
/// implementations breaks first-launch tray/UI agreement.
pub fn collapse_system_locale(raw: Option<&str>) -> Locale {
    match raw {
        Some(s) if s.starts_with("zh") => Locale::Zh,
        Some(_) => Locale::En,
        None => Locale::Zh,
    }
}

/// Template-table keys: 2 menu labels, 3 tooltip states, 1 cancelled body.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum TrayKey {
    ShowWindow,
    Quit,
    TooltipIdle,
    TooltipSyncing,
    TooltipFailed,
    NotifyCancelled,
}

/// Look up a tray/menu string for (locale, key). A const match over the
/// UI-SPEC-locked string table — no i18n crate (rejected: ~15 strings does
/// not justify a dependency).
pub fn tr(locale: Locale, key: TrayKey) -> String {
    match (locale, key) {
        (Locale::Zh, TrayKey::ShowWindow) => "显示窗口".into(),
        (Locale::En, TrayKey::ShowWindow) => "Show Window".into(),
        (Locale::Zh, TrayKey::Quit) => "退出".into(),
        (Locale::En, TrayKey::Quit) => "Quit".into(),
        (Locale::Zh, TrayKey::TooltipIdle) => "Simple UnrealGameSync - 空闲".into(),
        (Locale::En, TrayKey::TooltipIdle) => "Simple UnrealGameSync - Idle".into(),
        (Locale::Zh, TrayKey::TooltipSyncing) => "Simple UnrealGameSync - 同步中…".into(),
        (Locale::En, TrayKey::TooltipSyncing) => "Simple UnrealGameSync - Syncing…".into(),
        (Locale::Zh, TrayKey::TooltipFailed) => "Simple UnrealGameSync - 同步失败".into(),
        (Locale::En, TrayKey::TooltipFailed) => "Simple UnrealGameSync - Sync failed".into(),
        (Locale::Zh, TrayKey::NotifyCancelled) => "同步已取消".into(),
        (Locale::En, TrayKey::NotifyCancelled) => "Sync cancelled".into(),
    }
}

/// Compose the completed-notification body. The `(CL {cl})` segment is
/// conditional — appended ONLY when `cl` is `Some`, so `(CL )` with an empty
/// number never renders (UI-SPEC formatting rule 2). `{n}` renders plain
/// Arabic digits, no thousands separator (rule 3). Em-dash with one space
/// each side (rule 1).
pub fn compose_completed(locale: Locale, files_synced: u64, cl: Option<&str>) -> String {
    let base = match locale {
        Locale::Zh => format!("同步完成 — 已同步 {files_synced} 个文件"),
        Locale::En => format!("Sync completed — synced {files_synced} files"),
    };
    match cl {
        Some(cl) => format!("{base} (CL {cl})"),
        None => base,
    }
}

/// Compose the failed-notification body: localized prefix naming the machine
/// step token (rendered verbatim, untranslated — BND-01), then ASCII
/// `": "` + the FIRST LINE of the raw error only (research Pitfall 8: no
/// multi-line p4/git output in the toast). An empty error renders the
/// prefix alone with no trailing colon (UI-SPEC rule 4 + empty-input edge).
pub fn compose_failed(locale: Locale, step: &str, error: &str) -> String {
    let prefix = match locale {
        Locale::Zh => format!("同步在 {step} 步骤失败"),
        Locale::En => format!("Sync failed at step {step}"),
    };
    match error.lines().next().map(str::trim).filter(|l| !l.is_empty()) {
        Some(first) => format!("{prefix}: {first}"),
        None => prefix,
    }
}

/// Map a sync-state tag to its tooltip key. Total over BOTH tag generations
/// (current: syncing/idle/error; Plan 03 renames: running/completed/
/// cancelled/failed). Unknown tags return None so the tray listener
/// returns early.
pub fn tooltip_key_for_state(state: &str) -> Option<TrayKey> {
    match state {
        "syncing" | "running" => Some(TrayKey::TooltipSyncing),
        "idle" | "completed" | "cancelled" => Some(TrayKey::TooltipIdle),
        "error" | "failed" => Some(TrayKey::TooltipFailed),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tr_returns_locked_zh_and_en_menu_labels() {
        assert_eq!(tr(Locale::Zh, TrayKey::ShowWindow), "显示窗口");
        assert_eq!(tr(Locale::En, TrayKey::ShowWindow), "Show Window");
        assert_eq!(tr(Locale::Zh, TrayKey::Quit), "退出");
        assert_eq!(tr(Locale::En, TrayKey::Quit), "Quit");
    }

    #[test]
    fn syncing_tooltip_uses_u2026_ellipsis_not_ascii_dots() {
        assert_eq!(
            tr(Locale::Zh, TrayKey::TooltipSyncing),
            "Simple UnrealGameSync - 同步中…"
        );
        assert_eq!(
            tr(Locale::En, TrayKey::TooltipSyncing),
            "Simple UnrealGameSync - Syncing…"
        );
        // U+2026 (…), NOT three ASCII dots (corrects the old tray_manager
        // ASCII "..." tooltip).
        assert!(!tr(Locale::Zh, TrayKey::TooltipSyncing).ends_with("..."));
        assert!(!tr(Locale::En, TrayKey::TooltipSyncing).ends_with("..."));
    }

    #[test]
    fn every_tray_key_returns_nonempty_for_both_locales() {
        const KEYS: [TrayKey; 6] = [
            TrayKey::ShowWindow,
            TrayKey::Quit,
            TrayKey::TooltipIdle,
            TrayKey::TooltipSyncing,
            TrayKey::TooltipFailed,
            TrayKey::NotifyCancelled,
        ];
        for key in KEYS {
            for locale in [Locale::Zh, Locale::En] {
                let s = tr(locale, key);
                assert!(!s.is_empty(), "empty string for {locale:?} {key:?}");
            }
        }
    }

    #[test]
    fn tooltip_entries_carry_the_untranslated_brand_prefix() {
        // TRAY-03: the brand is identical in both locales, everywhere it
        // appears — every tooltip arm starts with the single APP_TITLE const.
        for locale in [Locale::Zh, Locale::En] {
            for key in [
                TrayKey::TooltipIdle,
                TrayKey::TooltipSyncing,
                TrayKey::TooltipFailed,
            ] {
                assert!(tr(locale, key).starts_with(APP_TITLE), "{locale:?} {key:?}");
            }
        }
    }

    #[test]
    fn tooltip_idle_and_failed_spot_values() {
        assert_eq!(
            tr(Locale::Zh, TrayKey::TooltipIdle),
            "Simple UnrealGameSync - 空闲"
        );
        assert_eq!(
            tr(Locale::En, TrayKey::TooltipIdle),
            "Simple UnrealGameSync - Idle"
        );
        assert_eq!(
            tr(Locale::Zh, TrayKey::TooltipFailed),
            "Simple UnrealGameSync - 同步失败"
        );
        assert_eq!(
            tr(Locale::En, TrayKey::TooltipFailed),
            "Simple UnrealGameSync - Sync failed"
        );
    }

    #[test]
    fn notify_cancelled_spot_values() {
        assert_eq!(tr(Locale::Zh, TrayKey::NotifyCancelled), "同步已取消");
        assert_eq!(tr(Locale::En, TrayKey::NotifyCancelled), "Sync cancelled");
    }

    #[test]
    fn compose_completed_with_cl_appends_the_cl_segment() {
        assert_eq!(
            compose_completed(Locale::Zh, 163681, Some("1234567")),
            "同步完成 — 已同步 163681 个文件 (CL 1234567)"
        );
        assert_eq!(
            compose_completed(Locale::En, 163681, Some("1234567")),
            "Sync completed — synced 163681 files (CL 1234567)"
        );
    }

    #[test]
    fn compose_completed_without_cl_omits_the_segment_entirely() {
        assert_eq!(
            compose_completed(Locale::En, 5, None),
            "Sync completed — synced 5 files"
        );
        assert_eq!(
            compose_completed(Locale::Zh, 5, None),
            "同步完成 — 已同步 5 个文件"
        );
        // `(CL )` with an empty number never renders.
        assert!(!compose_completed(Locale::Zh, 5, None).contains("CL"));
        assert!(!compose_completed(Locale::En, 5, None).contains("("));
    }

    #[test]
    fn compose_completed_uses_plain_digits_no_thousands_separator() {
        let s = compose_completed(Locale::En, 163681, None);
        assert!(s.contains("163681"));
        assert!(!s.contains("163,681"));
    }

    #[test]
    fn compose_completed_uses_em_dash_with_one_space_each_side() {
        assert!(compose_completed(Locale::En, 1, None).contains(" — "));
        assert!(compose_completed(Locale::Zh, 1, None).contains(" — "));
    }

    #[test]
    fn compose_failed_appends_only_the_first_line_of_the_raw_error() {
        assert_eq!(
            compose_failed(Locale::En, "p4Sync", "line1\nline2"),
            "Sync failed at step p4Sync: line1"
        );
        // multi-line zh case: first line only, ASCII colon + one space
        assert_eq!(
            compose_failed(Locale::Zh, "p4Sync", "line1\nline2"),
            "同步在 p4Sync 步骤失败: line1"
        );
    }

    #[test]
    fn compose_failed_with_empty_error_renders_prefix_alone() {
        assert_eq!(
            compose_failed(Locale::Zh, "closeUe", ""),
            "同步在 closeUe 步骤失败"
        );
        let en = compose_failed(Locale::En, "p4Sync", "");
        assert_eq!(en, "Sync failed at step p4Sync");
        assert!(!en.ends_with(":"));
        assert!(!en.ends_with(": "));
    }

    #[test]
    fn compose_failed_renders_the_step_token_verbatim() {
        // Machine step identifier, untranslated in both locales (BND-01).
        assert_eq!(
            compose_failed(Locale::Zh, "closeUe", "boom"),
            "同步在 closeUe 步骤失败: boom"
        );
        assert_eq!(
            compose_failed(Locale::En, "closeUe", "boom"),
            "Sync failed at step closeUe: boom"
        );
    }

    #[test]
    fn collapse_system_locale_ports_the_i18n04_rule() {
        assert_eq!(collapse_system_locale(Some("zh-CN")), Locale::Zh);
        assert_eq!(collapse_system_locale(Some("en-GB")), Locale::En);
        assert_eq!(collapse_system_locale(Some("fr")), Locale::En);
        assert_eq!(collapse_system_locale(None), Locale::Zh);
    }

    #[test]
    fn tooltip_key_for_state_maps_both_tag_generations() {
        // current generation
        assert_eq!(
            tooltip_key_for_state("syncing"),
            Some(TrayKey::TooltipSyncing)
        );
        assert_eq!(tooltip_key_for_state("idle"), Some(TrayKey::TooltipIdle));
        assert_eq!(
            tooltip_key_for_state("error"),
            Some(TrayKey::TooltipFailed)
        );
        // Plan 03 generation
        assert_eq!(
            tooltip_key_for_state("running"),
            Some(TrayKey::TooltipSyncing)
        );
        assert_eq!(
            tooltip_key_for_state("completed"),
            Some(TrayKey::TooltipIdle)
        );
        assert_eq!(
            tooltip_key_for_state("cancelled"),
            Some(TrayKey::TooltipIdle)
        );
        assert_eq!(
            tooltip_key_for_state("failed"),
            Some(TrayKey::TooltipFailed)
        );
        // unrecognized -> None (listener returns early)
        assert_eq!(tooltip_key_for_state("garbage"), None);
    }

    #[test]
    fn app_locale_get_set_round_trip() {
        let state = AppLocale::new(Locale::Zh);
        assert_eq!(state.get(), Locale::Zh);
        state.set(Locale::En);
        assert_eq!(state.get(), Locale::En);
        // repeated same-value writes are idempotent
        state.set(Locale::En);
        assert_eq!(state.get(), Locale::En);
        state.set(Locale::Zh);
        assert_eq!(state.get(), Locale::Zh);
    }

    #[test]
    fn locale_serde_renames_match_the_store_wire_values() {
        assert_eq!(serde_json::to_string(&Locale::Zh).unwrap(), "\"zh\"");
        assert_eq!(serde_json::to_string(&Locale::En).unwrap(), "\"en\"");
        assert_eq!(
            serde_json::from_str::<Locale>("\"zh\"").unwrap(),
            Locale::Zh
        );
        assert_eq!(
            serde_json::from_str::<Locale>("\"en\"").unwrap(),
            Locale::En
        );
    }
}
