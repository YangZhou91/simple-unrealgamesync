use crate::error::AppError;
use crate::models::WorkspaceConfig;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const STORE_NAME: &str = "workspaces.json";
const WORKSPACES_KEY: &str = "workspaces";

pub struct WorkspaceService;

impl WorkspaceService {
    pub fn new() -> Self {
        Self
    }

    pub async fn list(app: &AppHandle) -> Result<Vec<WorkspaceConfig>, AppError> {
        let store = app
            .store(STORE_NAME)
            .map_err(|e| AppError::Store(e.to_string()))?;

        let value = store.get(WORKSPACES_KEY);
        let result = match value {
            Some(v) => serde_json::from_value::<Vec<WorkspaceConfig>>(v.clone())
                .map_err(|e| AppError::Serialization(e.to_string()))?,
            None => vec![],
        };
        Ok(result)
    }

    pub async fn add(
        app: &AppHandle,
        mut workspace: WorkspaceConfig,
    ) -> Result<WorkspaceConfig, AppError> {
        let store = app
            .store(STORE_NAME)
            .map_err(|e| AppError::Store(e.to_string()))?;

        let mut workspaces = Self::list(app).await?;
        if workspace.id.is_empty() {
            workspace.id = uuid::Uuid::new_v4().to_string();
        }
        let returned = workspace.clone();
        workspaces.push(workspace);

        store.set(
            WORKSPACES_KEY,
            serde_json::to_value(&workspaces)
                .map_err(|e| AppError::Serialization(e.to_string()))?,
        );
        store.save().map_err(|e| AppError::Store(e.to_string()))?;

        Ok(returned)
    }

    pub async fn delete(app: &AppHandle, id: &str) -> Result<(), AppError> {
        let store = app
            .store(STORE_NAME)
            .map_err(|e| AppError::Store(e.to_string()))?;

        let mut workspaces = Self::list(app).await?;
        let before = workspaces.len();
        workspaces.retain(|ws| ws.id != id);
        if workspaces.len() == before {
            return Err(AppError::WorkspaceNotFound(id.to_string()));
        }

        store.set(
            WORKSPACES_KEY,
            serde_json::to_value(&workspaces)
                .map_err(|e| AppError::Serialization(e.to_string()))?,
        );
        store.save().map_err(|e| AppError::Store(e.to_string()))?;

        Ok(())
    }

    pub async fn get(app: &AppHandle, id: &str) -> Result<WorkspaceConfig, AppError> {
        let workspaces = Self::list(app).await?;
        workspaces
            .into_iter()
            .find(|ws| ws.id == id)
            .ok_or_else(|| AppError::WorkspaceNotFound(id.to_string()))
    }

    pub async fn update(
        app: &AppHandle,
        id: &str,
        f: impl FnOnce(&mut WorkspaceConfig),
    ) -> Result<WorkspaceConfig, AppError> {
        let store = app
            .store(STORE_NAME)
            .map_err(|e| AppError::Store(e.to_string()))?;

        let mut workspaces = Self::list(app).await?;
        let ws = workspaces
            .iter_mut()
            .find(|ws| ws.id == id)
            .ok_or_else(|| AppError::WorkspaceNotFound(id.to_string()))?;
        f(ws);
        let updated = ws.clone();

        store.set(
            WORKSPACES_KEY,
            serde_json::to_value(&workspaces)
                .map_err(|e| AppError::Serialization(e.to_string()))?,
        );
        store.save().map_err(|e| AppError::Store(e.to_string()))?;

        Ok(updated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_workspace_config_serialization() {
        let ws = WorkspaceConfig {
            id: "test-id".to_string(),
            name: "Test".to_string(),
            root_path: "E:\\test".to_string(),
            project_dir: "MyGame".to_string(),
            p4_client: "test_client".to_string(),
            p4_user: "test_user".to_string(),
            last_sync_cl: None,
            last_sync_time: None,
            last_sync_file_count: None,
            parallel_threads: 4,
            exclusions: vec!["Binaries".to_string()],
            interval_minutes: 60,
        };

        let json = serde_json::to_string(&ws).unwrap();
        let deserialized: WorkspaceConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(ws.id, deserialized.id);
        assert_eq!(ws.name, deserialized.name);
    }

    #[test]
    fn test_vec_workspace_serialization() {
        let ws_list = vec![
            WorkspaceConfig {
                id: "1".to_string(),
                name: "WS1".to_string(),
                root_path: "E:\\ws1".to_string(),
                project_dir: "MyGame".to_string(),
                p4_client: "c1".to_string(),
                p4_user: "u1".to_string(),
                last_sync_cl: Some("12345".to_string()),
                last_sync_time: None,
                last_sync_file_count: None,
                parallel_threads: 4,
                exclusions: vec![],
                interval_minutes: 60,
            },
            WorkspaceConfig {
                id: "2".to_string(),
                name: "WS2".to_string(),
                root_path: "E:\\ws2".to_string(),
                project_dir: "MyGame".to_string(),
                p4_client: "c2".to_string(),
                p4_user: "u2".to_string(),
                last_sync_cl: None,
                last_sync_time: None,
                last_sync_file_count: None,
                parallel_threads: 4,
                exclusions: vec![],
                interval_minutes: 60,
            },
        ];

        let json = serde_json::to_string(&ws_list).unwrap();
        let deserialized: Vec<WorkspaceConfig> = serde_json::from_str(&json).unwrap();
        assert_eq!(2, deserialized.len());
        assert_eq!("12345", deserialized[0].last_sync_cl.as_deref().unwrap());
    }
}
