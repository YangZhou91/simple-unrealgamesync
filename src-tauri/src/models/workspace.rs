use serde::{Deserialize, Deserializer, Serialize};

pub fn default_parallel_threads() -> u32 {
    4
}

pub fn default_project_dir() -> String {
    "MyGame".to_string()
}

pub fn default_exclusions() -> Vec<String> {
    vec![
        "Binaries".to_string(),
        "Content/Developers".to_string(),
        "Content/TestData".to_string(),
        "Intermediate".to_string(),
    ]
}

pub fn clamp_parallel_threads<'de, D>(d: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let v: u32 = u32::deserialize(d)?;
    Ok(v.clamp(1, 16))
}

pub fn default_interval_minutes() -> u32 {
    60
}

pub fn clamp_interval_minutes<'de, D>(d: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let v: u32 = u32::deserialize(d)?;
    Ok(v.clamp(5, 1440))
}

#[derive(Clone, Serialize, Deserialize)]
pub struct WorkspaceConfig {
    pub id: String,
    pub name: String,
    #[serde(rename = "rootPath", alias = "root_path")]
    pub root_path: String,
    #[serde(
        default = "default_project_dir",
        rename = "projectDir",
        alias = "project_dir"
    )]
    pub project_dir: String,
    #[serde(rename = "p4Client", alias = "p4_client")]
    pub p4_client: String,
    #[serde(rename = "p4User", alias = "p4_user")]
    pub p4_user: String,
    #[serde(rename = "lastSyncCl", alias = "last_sync_cl")]
    pub last_sync_cl: Option<String>,
    #[serde(rename = "lastSyncTime", alias = "last_sync_time")]
    pub last_sync_time: Option<String>,
    #[serde(rename = "lastSyncFileCount", alias = "last_sync_file_count")]
    pub last_sync_file_count: Option<u64>,
    #[serde(
        default = "default_parallel_threads",
        rename = "parallelThreads",
        alias = "parallel_threads",
        deserialize_with = "clamp_parallel_threads"
    )]
    pub parallel_threads: u32,
    #[serde(default = "default_exclusions")]
    pub exclusions: Vec<String>,
    #[serde(
        default = "default_interval_minutes",
        rename = "intervalMinutes",
        alias = "interval_minutes",
        deserialize_with = "clamp_interval_minutes"
    )]
    pub interval_minutes: u32,
}

/// Manual `Debug` for `WorkspaceConfig` — the REDACT-06 / D-05 defense-in-depth
/// backstop.
///
/// Per D-05, the format-layer `redact()` net (Wave 1, `utils/redact.rs`) is the
/// audited security boundary and the ONLY layer that protects
/// Display / error-chain / panic / `io::Error` paths (they render to a string
/// before any struct is involved). This struct-level `Debug` is a pragmatic,
/// testable backstop that masks the OBVIOUS sensitive fields (`name`,
/// `root_path`, `p4_client`, `p4_user`) so `{:?}` formatting cannot leak them
/// even before the net sees the rendered string. Non-identity fields are kept
/// so `Debug` remains useful (e.g. `parallel_threads`, `exclusions`).
impl std::fmt::Debug for WorkspaceConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkspaceConfig")
            .field("id", &self.id)
            .field("name", &"<redacted>")
            .field("root_path", &"<redacted>")
            .field("project_dir", &self.project_dir)
            .field("p4_client", &"<redacted>")
            .field("p4_user", &"<redacted>")
            .field("last_sync_cl", &self.last_sync_cl)
            .field("last_sync_time", &self.last_sync_time)
            .field("last_sync_file_count", &self.last_sync_file_count)
            .field("parallel_threads", &self.parallel_threads)
            .field("exclusions", &self.exclusions)
            .field("interval_minutes", &self.interval_minutes)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_parallel_threads() {
        assert_eq!(default_parallel_threads(), 4);
    }

    #[test]
    fn test_default_exclusions() {
        let exclusions = default_exclusions();
        assert_eq!(exclusions.len(), 4);
        assert!(exclusions.contains(&"Binaries".to_string()));
        assert!(exclusions.contains(&"Content/Developers".to_string()));
        assert!(exclusions.contains(&"Content/TestData".to_string()));
        assert!(exclusions.contains(&"Intermediate".to_string()));
    }

    #[test]
    fn test_workspace_config_new_fields_default() {
        // Old JSON without parallel_threads and exclusions fields
        let old_json = r#"{
            "id": "test-id",
            "name": "Test",
            "root_path": "E:\\test",
            "p4_client": "test_client",
            "p4_user": "test_user",
            "last_sync_cl": null,
            "last_sync_time": null,
            "last_sync_file_count": null
        }"#;
        let config: WorkspaceConfig = serde_json::from_str(old_json).unwrap();
        assert_eq!(config.parallel_threads, 4);
        assert_eq!(config.exclusions.len(), 4);
    }

    #[test]
    fn test_parallel_threads_zero_clamped_to_one() {
        let json = r#"{
            "id": "test-id",
            "name": "Test",
            "root_path": "E:\\test",
            "p4_client": "test_client",
            "p4_user": "test_user",
            "parallelThreads": 0,
            "exclusions": []
        }"#;
        let config: WorkspaceConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.parallel_threads, 1);
    }

    #[test]
    fn test_parallel_threads_over_max_clamped_to_sixteen() {
        let json = r#"{
            "id": "test-id",
            "name": "Test",
            "root_path": "E:\\test",
            "p4_client": "test_client",
            "p4_user": "test_user",
            "parallelThreads": 99,
            "exclusions": []
        }"#;
        let config: WorkspaceConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.parallel_threads, 16);
    }

    #[test]
    fn test_parallel_threads_valid_value_unchanged() {
        let json = r#"{
            "id": "test-id",
            "name": "Test",
            "root_path": "E:\\test",
            "p4_client": "test_client",
            "p4_user": "test_user",
            "parallelThreads": 8,
            "exclusions": []
        }"#;
        let config: WorkspaceConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.parallel_threads, 8);
    }

    #[test]
    fn test_default_interval_minutes() {
        assert_eq!(default_interval_minutes(), 60);
    }

    #[test]
    fn test_default_project_dir() {
        assert_eq!(default_project_dir(), "MyGame");
    }

    #[test]
    fn test_project_dir_old_json_defaults_to_mygame() {
        // Old JSON without projectDir field falls back to the default
        let old_json = r#"{
            "id": "test-id",
            "name": "Test",
            "root_path": "E:\\test",
            "p4_client": "test_client",
            "p4_user": "test_user",
            "last_sync_cl": null,
            "last_sync_time": null,
            "last_sync_file_count": null
        }"#;
        let config: WorkspaceConfig = serde_json::from_str(old_json).unwrap();
        assert_eq!(config.project_dir, "MyGame");
    }

    #[test]
    fn test_project_dir_custom_value_parsed() {
        let json = r#"{
            "id": "test-id",
            "name": "Test",
            "root_path": "E:\\test",
            "projectDir": "MyGame",
            "p4_client": "test_client",
            "p4_user": "test_user"
        }"#;
        let config: WorkspaceConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.project_dir, "MyGame");
    }

    #[test]
    fn test_interval_minutes_old_json_defaults_to_sixty() {
        // Old JSON without intervalMinutes field
        let old_json = r#"{
            "id": "test-id",
            "name": "Test",
            "root_path": "E:\\test",
            "p4_client": "test_client",
            "p4_user": "test_user",
            "last_sync_cl": null,
            "last_sync_time": null,
            "last_sync_file_count": null
        }"#;
        let config: WorkspaceConfig = serde_json::from_str(old_json).unwrap();
        assert_eq!(config.interval_minutes, 60);
    }

    #[test]
    fn test_interval_minutes_below_min_clamped_to_five() {
        let json = r#"{
            "id": "test-id",
            "name": "Test",
            "root_path": "E:\\test",
            "p4_client": "test_client",
            "p4_user": "test_user",
            "intervalMinutes": 1
        }"#;
        let config: WorkspaceConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.interval_minutes, 5);
    }

    #[test]
    fn test_interval_minutes_over_max_clamped_to_1440() {
        let json = r#"{
            "id": "test-id",
            "name": "Test",
            "root_path": "E:\\test",
            "p4_client": "test_client",
            "p4_user": "test_user",
            "intervalMinutes": 99999
        }"#;
        let config: WorkspaceConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.interval_minutes, 1440);
    }

    #[test]
    fn test_interval_minutes_valid_value_unchanged() {
        let json = r#"{
            "id": "test-id",
            "name": "Test",
            "root_path": "E:\\test",
            "p4_client": "test_client",
            "p4_user": "test_user",
            "intervalMinutes": 30
        }"#;
        let config: WorkspaceConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.interval_minutes, 30);
    }

    // ---- SC#2: manual Debug does not leak identity (REDACT-06 / D-05 backstop) ----

    #[test]
    fn debug_does_not_leak_identity() {
        // The format-layer redact() net is the audited boundary (Wave 1); this
        // struct-level Debug is the pragmatic backstop. It MUST mask the obvious
        // identity fields (name/root_path/p4_client/p4_user) so `{:?}` formatting
        // cannot leak them even before the net sees the rendered string.
        let ws = crate::utils::redact::test_workspace_fixture();
        let dbg = format!("{:?}", ws);
        assert!(!dbg.contains("alice"), "Debug leaked username: {dbg}");
        assert!(
            !dbg.contains("alice-laptop-fygame"),
            "Debug leaked p4_client: {dbg}"
        );
        assert!(!dbg.contains(r"C:\Users"), "Debug leaked root_path: {dbg}");
        assert!(
            dbg.contains("WorkspaceConfig"),
            "Debug must still identify the type"
        );
    }

    // ---- quick/260630-rsp: camelCase IPC serialization regression guards ----

    #[test]
    fn workspace_config_serializes_camelcase_keys() {
        // Regression guard: serde MUST emit camelCase keys so the frontend
        // (src/lib/types.ts WorkspaceConfig) reads them. The old code emitted
        // snake_case and the frontend silently saw `undefined` (empty "Client:"
        // line). Round-tripping without asserting key names let this ship.
        let cfg = WorkspaceConfig {
            id: "ws-camel".to_string(),
            name: "Camel".to_string(),
            root_path: "E:\\proj".to_string(),
            project_dir: "MyGame".to_string(),
            p4_client: "bravo-laptop-fygame".to_string(),
            p4_user: "bravo".to_string(),
            last_sync_cl: Some("123456".to_string()),
            last_sync_time: Some("2026-06-30T00:00:00Z".to_string()),
            last_sync_file_count: Some(42),
            parallel_threads: 4,
            exclusions: default_exclusions(),
            interval_minutes: 60,
        };
        let json_str = serde_json::to_string(&cfg).unwrap();

        // camelCase keys present
        assert!(json_str.contains("\"p4Client\""), "missing p4Client: {json_str}");
        assert!(json_str.contains("\"rootPath\""), "missing rootPath: {json_str}");
        assert!(json_str.contains("\"p4User\""), "missing p4User: {json_str}");
        assert!(
            json_str.contains("\"lastSyncCl\""),
            "missing lastSyncCl: {json_str}"
        );
        assert!(
            json_str.contains("\"lastSyncTime\""),
            "missing lastSyncTime: {json_str}"
        );
        assert!(
            json_str.contains("\"lastSyncFileCount\""),
            "missing lastSyncFileCount: {json_str}"
        );

        // snake_case keys absent
        assert!(
            !json_str.contains("\"p4_client\""),
            "leaked snake_case p4_client: {json_str}"
        );
        assert!(
            !json_str.contains("\"root_path\""),
            "leaked snake_case root_path: {json_str}"
        );
        assert!(
            !json_str.contains("\"p4_user\""),
            "leaked snake_case p4_user: {json_str}"
        );
        assert!(
            !json_str.contains("\"last_sync_cl\""),
            "leaked snake_case last_sync_cl: {json_str}"
        );
        assert!(
            !json_str.contains("\"last_sync_time\""),
            "leaked snake_case last_sync_time: {json_str}"
        );
        assert!(
            !json_str.contains("\"last_sync_file_count\""),
            "leaked snake_case last_sync_file_count: {json_str}"
        );
    }

    #[test]
    fn workspace_config_deserializes_legacy_snake_case_keys() {
        // Backward compatibility: the on-disk workspaces.json
        // (%APPDATA%/com.simpleugs.app/workspaces.json) stores snake_case keys.
        // The alias attrs must keep loading that file with no migration.
        let legacy_json = r#"{
            "id": "ws-legacy",
            "name": "Legacy",
            "root_path": "E:\\proj",
            "projectDir": "MyGame",
            "p4_client": "bravo-laptop-fygame",
            "p4_user": "bravo",
            "last_sync_cl": "123456",
            "last_sync_time": "2026-06-30T00:00:00Z",
            "last_sync_file_count": 42
        }"#;
        let cfg: WorkspaceConfig = serde_json::from_str(legacy_json).unwrap();

        assert_eq!(cfg.id, "ws-legacy");
        assert_eq!(cfg.name, "Legacy");
        assert_eq!(cfg.root_path, "E:\\proj");
        assert_eq!(cfg.project_dir, "MyGame");
        assert_eq!(cfg.p4_client, "bravo-laptop-fygame");
        assert_eq!(cfg.p4_user, "bravo");
        assert_eq!(cfg.last_sync_cl.as_deref(), Some("123456"));
        assert_eq!(cfg.last_sync_time.as_deref(), Some("2026-06-30T00:00:00Z"));
        assert_eq!(cfg.last_sync_file_count, Some(42));
    }

    #[test]
    fn workspace_config_round_trips_camelcase() {
        // After the next save, workspaces.json will hold camelCase keys.
        // Deserialization must accept them too (round-trip).
        let cfg = WorkspaceConfig {
            id: "ws-rt".to_string(),
            name: "RoundTrip".to_string(),
            root_path: "E:\\proj".to_string(),
            project_dir: "MyGame".to_string(),
            p4_client: "bravo-laptop-fygame".to_string(),
            p4_user: "bravo".to_string(),
            last_sync_cl: None,
            last_sync_time: None,
            last_sync_file_count: None,
            parallel_threads: 8,
            exclusions: default_exclusions(),
            interval_minutes: 30,
        };
        let json_str = serde_json::to_string(&cfg).unwrap();
        let back: WorkspaceConfig = serde_json::from_str(&json_str).unwrap();

        assert_eq!(back.id, cfg.id);
        assert_eq!(back.name, cfg.name);
        assert_eq!(back.root_path, cfg.root_path);
        assert_eq!(back.project_dir, cfg.project_dir);
        assert_eq!(back.p4_client, cfg.p4_client);
        assert_eq!(back.p4_user, cfg.p4_user);
        assert_eq!(back.last_sync_cl, cfg.last_sync_cl);
        assert_eq!(back.last_sync_time, cfg.last_sync_time);
        assert_eq!(back.last_sync_file_count, cfg.last_sync_file_count);
        assert_eq!(back.parallel_threads, cfg.parallel_threads);
        assert_eq!(back.exclusions, cfg.exclusions);
        assert_eq!(back.interval_minutes, cfg.interval_minutes);
    }
}
