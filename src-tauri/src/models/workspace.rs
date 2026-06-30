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
}
