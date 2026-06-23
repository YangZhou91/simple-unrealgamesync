use crate::error::AppError;
use crate::models::HistoryRecord;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const HISTORY_STORE: &str = "history.json";

pub struct HistoryService;

impl HistoryService {
    pub async fn save_record(app: &AppHandle, record: HistoryRecord) -> Result<(), AppError> {
        let store = app
            .store(HISTORY_STORE)
            .map_err(|e| AppError::Store(e.to_string()))?;

        let key = format!("history_{}", record.workspace_id);
        let mut records: Vec<HistoryRecord> = store
            .get(&key)
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();

        // Insert new record at position 0 (newest first)
        records.insert(0, record);

        // Auto-prune records older than 90 days
        let cutoff = now_epoch_secs() - (90 * 86400);
        prune_records(&mut records, cutoff);

        store.set(
            key,
            serde_json::to_value(&records).map_err(|e| AppError::Serialization(e.to_string()))?,
        );
        store.save().map_err(|e| AppError::Store(e.to_string()))?;

        Ok(())
    }

    pub async fn list_records(
        app: &AppHandle,
        workspace_id: &str,
    ) -> Result<Vec<HistoryRecord>, AppError> {
        let store = app
            .store(HISTORY_STORE)
            .map_err(|e| AppError::Store(e.to_string()))?;

        let key = format!("history_{}", workspace_id);
        let mut records: Vec<HistoryRecord> = store
            .get(&key)
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();

        // Filter out zero-file records (stale/no-op syncs)
        let before = records.len();
        records.retain(|r| r.file_count > 0);
        if records.len() != before {
            store.set(
                key,
                serde_json::to_value(&records)
                    .map_err(|e| AppError::Serialization(e.to_string()))?,
            );
            let _ = store.save();
        }

        Ok(records)
    }

    pub async fn delete_records(app: &AppHandle, workspace_id: &str) -> Result<(), AppError> {
        let store = app
            .store(HISTORY_STORE)
            .map_err(|e| AppError::Store(e.to_string()))?;

        let key = format!("history_{}", workspace_id);
        store.delete(&key);
        store.save().map_err(|e| AppError::Store(e.to_string()))?;

        Ok(())
    }
}

/// Prune records older than the given cutoff epoch seconds.
/// Returns the pruned vector (modifies in place).
pub fn prune_records(records: &mut Vec<HistoryRecord>, cutoff_epoch: u64) {
    records.retain(|r| parse_timestamp_epoch_secs(&r.timestamp) > cutoff_epoch);
}

/// Parse an ISO 8601-like timestamp string to epoch seconds.
/// Supports format: "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DDTHH:MM:SSZ"
fn parse_timestamp_epoch_secs(timestamp: &str) -> u64 {
    // Normalize: replace T with space, strip trailing Z
    let normalized = timestamp
        .replace('T', " ")
        .trim_end_matches('Z')
        .to_string();

    // Format: "YYYY-MM-DD HH:MM:SS"
    let parts: Vec<&str> = normalized.split_whitespace().collect();
    if parts.len() != 2 {
        return 0;
    }

    let date_parts: Vec<u64> = parts[0].split('-').filter_map(|s| s.parse().ok()).collect();
    let time_parts: Vec<u64> = parts[1].split(':').filter_map(|s| s.parse().ok()).collect();

    if date_parts.len() != 3 || time_parts.len() != 3 {
        return 0;
    }

    let year = date_parts[0];
    let month = date_parts[1];
    let day = date_parts[2];
    let hour = time_parts[0];
    let minute = time_parts[1];
    let second = time_parts[2];

    // Calculate days from epoch
    let mut total_days: u64 = 0;
    for y in 1970..year {
        total_days += if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
            366
        } else {
            365
        };
    }

    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let month_days: [u64; 12] = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    for m in 0..(month.saturating_sub(1)) {
        total_days += month_days.get(m as usize).copied().unwrap_or(0);
    }
    total_days += day.saturating_sub(1);

    total_days * 86400 + hour * 3600 + minute * 60 + second
}

fn now_epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::time::epoch_days_to_date;

    #[test]
    fn test_history_record_serialization_roundtrip() {
        let record = HistoryRecord {
            changelist: "12345".to_string(),
            timestamp: "2024-01-15 10:30:00".to_string(),
            file_count: 42,
            workspace_id: "ws-uuid-123".to_string(),
        };

        let json = serde_json::to_string(&record).unwrap();
        let deserialized: HistoryRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(record.changelist, deserialized.changelist);
        assert_eq!(record.file_count, deserialized.file_count);
        assert_eq!(record.workspace_id, deserialized.workspace_id);
    }

    #[test]
    fn test_parse_timestamp_epoch_secs_standard() {
        // 2024-01-15 10:30:00
        let epoch = parse_timestamp_epoch_secs("2024-01-15 10:30:00");
        assert!(epoch > 0);
    }

    #[test]
    fn test_parse_timestamp_epoch_secs_iso_format() {
        let epoch1 = parse_timestamp_epoch_secs("2024-01-15 10:30:00");
        let epoch2 = parse_timestamp_epoch_secs("2024-01-15T10:30:00Z");
        assert_eq!(epoch1, epoch2);
    }

    #[test]
    fn test_parse_timestamp_epoch_secs_ordering() {
        let older = parse_timestamp_epoch_secs("2024-01-01 00:00:00");
        let newer = parse_timestamp_epoch_secs("2024-06-01 00:00:00");
        assert!(newer > older);
    }

    #[test]
    fn test_prune_records_removes_old() {
        let cutoff = 1705276800u64; // 2024-01-15 00:00:00 approx

        let mut records = vec![
            HistoryRecord {
                changelist: "100".to_string(),
                timestamp: "2024-06-01 12:00:00".to_string(), // recent
                file_count: 10,
                workspace_id: "ws1".to_string(),
            },
            HistoryRecord {
                changelist: "99".to_string(),
                timestamp: "2023-06-01 12:00:00".to_string(), // old (before cutoff)
                file_count: 5,
                workspace_id: "ws1".to_string(),
            },
        ];

        prune_records(&mut records, cutoff);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].changelist, "100");
    }

    #[test]
    fn test_prune_records_keeps_all_recent() {
        let cutoff = 1700000000u64; // well in the past

        let mut records = vec![
            HistoryRecord {
                changelist: "100".to_string(),
                timestamp: "2024-06-01 12:00:00".to_string(),
                file_count: 10,
                workspace_id: "ws1".to_string(),
            },
            HistoryRecord {
                changelist: "99".to_string(),
                timestamp: "2024-05-01 12:00:00".to_string(),
                file_count: 5,
                workspace_id: "ws1".to_string(),
            },
        ];

        prune_records(&mut records, cutoff);
        assert_eq!(records.len(), 2);
    }

    #[test]
    fn test_newest_first_ordering() {
        // Simulating save_record behavior: insert at 0
        let mut records: Vec<HistoryRecord> = vec![];

        records.insert(
            0,
            HistoryRecord {
                changelist: "100".to_string(),
                timestamp: "2024-01-01 10:00:00".to_string(),
                file_count: 10,
                workspace_id: "ws1".to_string(),
            },
        );
        records.insert(
            0,
            HistoryRecord {
                changelist: "200".to_string(),
                timestamp: "2024-01-02 10:00:00".to_string(),
                file_count: 20,
                workspace_id: "ws1".to_string(),
            },
        );
        records.insert(
            0,
            HistoryRecord {
                changelist: "300".to_string(),
                timestamp: "2024-01-03 10:00:00".to_string(),
                file_count: 30,
                workspace_id: "ws1".to_string(),
            },
        );

        // Newest should be first
        assert_eq!(records[0].changelist, "300");
        assert_eq!(records[1].changelist, "200");
        assert_eq!(records[2].changelist, "100");
    }

    #[test]
    fn test_prune_records_with_90_day_window() {
        // Create records spanning 100 days, verify only recent survive
        let now = now_epoch_secs();
        let cutoff = now - (90 * 86400);

        let mut records = vec![
            // Recent: within 90 days
            HistoryRecord {
                changelist: "500".to_string(),
                timestamp: format_timestamp(now - 86400), // 1 day ago
                file_count: 10,
                workspace_id: "ws1".to_string(),
            },
            // Exactly 89 days ago (should survive)
            HistoryRecord {
                changelist: "499".to_string(),
                timestamp: format_timestamp(now - 89 * 86400),
                file_count: 5,
                workspace_id: "ws1".to_string(),
            },
            // 91 days ago (should be pruned)
            HistoryRecord {
                changelist: "498".to_string(),
                timestamp: format_timestamp(now - 91 * 86400),
                file_count: 3,
                workspace_id: "ws1".to_string(),
            },
            // 100 days ago (should be pruned)
            HistoryRecord {
                changelist: "497".to_string(),
                timestamp: format_timestamp(now - 100 * 86400),
                file_count: 1,
                workspace_id: "ws1".to_string(),
            },
        ];

        prune_records(&mut records, cutoff);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].changelist, "500");
        assert_eq!(records[1].changelist, "499");
    }

    /// Helper: format epoch seconds to "YYYY-MM-DD HH:MM:SS"
    fn format_timestamp(epoch: u64) -> String {
        let days = epoch / 86400;
        let time_of_day = epoch % 86400;
        let hours = time_of_day / 3600;
        let minutes = (time_of_day % 3600) / 60;
        let seconds = time_of_day % 60;
        let (year, month, day) = epoch_days_to_date(days);
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
            year, month, day, hours, minutes, seconds
        )
    }
}
