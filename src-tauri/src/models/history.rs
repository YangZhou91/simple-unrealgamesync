use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRecord {
    pub changelist: String,
    pub timestamp: String,
    pub file_count: u64,
    pub workspace_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangelistEntry {
    pub number: String,
    pub date: String,
    pub user: String,
    pub client: String,
    pub description: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_history_record_serialization() {
        let record = HistoryRecord {
            changelist: "12345".to_string(),
            timestamp: "2024-01-15T10:30:00Z".to_string(),
            file_count: 42,
            workspace_id: "ws-uuid-123".to_string(),
            duration_ms: Some(120_000),
        };

        let json = serde_json::to_string(&record).unwrap();
        assert!(json.contains("\"changelist\":\"12345\""));
        assert!(json.contains("\"fileCount\":42"));
        assert!(json.contains("\"workspaceId\":\"ws-uuid-123\""));
        assert!(json.contains("\"durationMs\":120000"));

        let deserialized: HistoryRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(record.changelist, deserialized.changelist);
        assert_eq!(record.file_count, deserialized.file_count);
        assert_eq!(record.workspace_id, deserialized.workspace_id);
    }

    #[test]
    fn test_changelist_entry_serialization() {
        let entry = ChangelistEntry {
            number: "12345".to_string(),
            date: "2024/01/15".to_string(),
            user: "test_user".to_string(),
            client: "project_ws".to_string(),
            description: "Fix rendering bug".to_string(),
        };

        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"number\":\"12345\""));
        assert!(json.contains("\"user\":\"test_user\""));
        assert!(json.contains("\"client\":\"project_ws\""));

        let deserialized: ChangelistEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(entry.number, deserialized.number);
        assert_eq!(entry.description, deserialized.description);
    }
}
