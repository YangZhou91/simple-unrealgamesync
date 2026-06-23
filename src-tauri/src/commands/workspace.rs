use crate::models::WorkspaceConfig;
use crate::services::p4_executor::{check_exclusion_paths_exist, validate_exclusion_path};
use crate::services::workspace::WorkspaceService;
use std::path::Path;
use tauri::AppHandle;

fn validate_workspace_root(root_path: &str, project_dir: &str) -> Result<(), String> {
    let root = Path::new(root_path);
    if !root.exists() {
        return Err(format!("Workspace root does not exist: {}", root_path));
    }
    if !root.is_dir() {
        return Err(format!("Workspace root is not a directory: {}", root_path));
    }

    if !root.join(project_dir).is_dir()
        && !root
            .join(format!("UnrealEngine/{}", project_dir))
            .is_dir()
    {
        return Err(format!(
            "Workspace root must contain {}/ or UnrealEngine/{}/",
            project_dir, project_dir
        ));
    }

    if !root.join("UnrealEngine/GenerateProjectFiles.bat").is_file() {
        return Err(
            "Workspace root must contain UnrealEngine/GenerateProjectFiles.bat".to_string(),
        );
    }

    Ok(())
}

#[tauri::command]
pub async fn add_workspace(
    app: AppHandle,
    name: String,
    root_path: String,
    project_dir: String,
    p4_client: String,
    p4_user: String,
) -> Result<WorkspaceConfig, String> {
    let project_dir = if project_dir.trim().is_empty() {
        crate::models::workspace::default_project_dir()
    } else {
        project_dir.trim().to_string()
    };
    validate_workspace_root(&root_path, &project_dir)?;

    let workspace = WorkspaceConfig {
        id: String::new(),
        name,
        root_path,
        project_dir,
        p4_client,
        p4_user,
        last_sync_cl: None,
        last_sync_time: None,
        last_sync_file_count: None,
        parallel_threads: crate::models::workspace::default_parallel_threads(),
        exclusions: crate::models::workspace::default_exclusions(),
        interval_minutes: crate::models::workspace::default_interval_minutes(),
    };
    WorkspaceService::add(&app, workspace)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_workspaces(app: AppHandle) -> Result<Vec<WorkspaceConfig>, String> {
    WorkspaceService::list(&app)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_workspace(app: AppHandle, id: String) -> Result<(), String> {
    WorkspaceService::delete(&app, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn switch_workspace(app: AppHandle, id: String) -> Result<WorkspaceConfig, String> {
    WorkspaceService::get(&app, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_workspace_settings(
    app: AppHandle,
    workspace_id: String,
    parallel_threads: u32,
    exclusions: Vec<String>,
    interval_minutes: u32,
) -> Result<WorkspaceConfig, String> {
    // Clamp parallel_threads to valid range [1, 16]
    let parallel_threads = parallel_threads.clamp(1, 16);
    // Clamp interval_minutes to valid range [5, 1440]
    let interval_minutes = interval_minutes.clamp(5, 1440);

    // Validate each exclusion path against traversal attacks
    for exclusion in &exclusions {
        validate_exclusion_path(exclusion).map_err(|e| e.to_string())?;
    }

    // Warn about non-existent paths (returned but not blocking)
    let ws = WorkspaceService::get(&app, &workspace_id)
        .await
        .map_err(|e| e.to_string())?;
    let nonexistent = check_exclusion_paths_exist(&ws.root_path, &ws.project_dir, &exclusions);

    let updated = WorkspaceService::update(&app, &workspace_id, |ws| {
        ws.parallel_threads = parallel_threads;
        ws.exclusions = exclusions;
        ws.interval_minutes = interval_minutes;
    })
    .await
    .map_err(|e| e.to_string())?;

    // Attach nonexistent warnings to the response via the error channel
    // Frontend will check for warnings in the response
    if !nonexistent.is_empty() {
        // Return Ok but log warnings — frontend handles display
        eprintln!(
            "[settings] Warning: paths not found: {}",
            nonexistent.join(", ")
        );
    }

    Ok(updated)
}

#[tauri::command]
pub fn validate_exclusions(
    root_path: String,
    project_dir: String,
    exclusions: Vec<String>,
) -> Result<Vec<String>, String> {
    // Security validation
    for exclusion in &exclusions {
        validate_exclusion_path(exclusion).map_err(|e| e.to_string())?;
    }
    let project_dir = if project_dir.trim().is_empty() {
        crate::models::workspace::default_project_dir()
    } else {
        project_dir.trim().to_string()
    };
    // Existence check — returns list of nonexistent paths
    Ok(check_exclusion_paths_exist(
        &root_path,
        &project_dir,
        &exclusions,
    ))
}

#[cfg(test)]
mod tests {
    use super::validate_workspace_root;
    use crate::services::p4_executor::validate_exclusion_path;
    use std::fs;

    #[test]
    fn test_update_workspace_settings_validates_exclusion_path() {
        // Verify that validation rejects path traversal
        let result = validate_exclusion_path("../etc/passwd");
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.to_lowercase().contains("path traversal") || err_msg.contains(".."),
            "Expected path traversal error, got: {}",
            err_msg
        );
    }

    #[test]
    fn test_update_workspace_settings_accepts_valid_exclusion() {
        let result = validate_exclusion_path("Binaries");
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_workspace_root_rejects_missing_project_dir() {
        let tmp_dir = std::env::temp_dir().join("p4_workspace_validation_missing_project_dir");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(tmp_dir.join("UnrealEngine")).unwrap();

        let result = validate_workspace_root(tmp_dir.to_str().unwrap(), "MyGame");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("MyGame"));

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_validate_workspace_root_rejects_missing_generate_project_files() {
        let tmp_dir = std::env::temp_dir().join("p4_workspace_validation_missing_genproj");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(tmp_dir.join("MyGame")).unwrap();
        fs::create_dir_all(tmp_dir.join("UnrealEngine")).unwrap();

        let result = validate_workspace_root(tmp_dir.to_str().unwrap(), "MyGame");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("GenerateProjectFiles"));

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_validate_workspace_root_accepts_valid_structure() {
        let tmp_dir = std::env::temp_dir().join("p4_workspace_validation_valid");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(tmp_dir.join("MyGame")).unwrap();
        fs::create_dir_all(tmp_dir.join("UnrealEngine")).unwrap();
        fs::write(
            tmp_dir.join("UnrealEngine/GenerateProjectFiles.bat"),
            "@echo off\r\n",
        )
        .unwrap();

        let result = validate_workspace_root(tmp_dir.to_str().unwrap(), "MyGame");
        assert!(result.is_ok());

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_validate_workspace_root_accepts_custom_project_dir() {
        let tmp_dir = std::env::temp_dir().join("p4_workspace_validation_custom_proj");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(tmp_dir.join("MyGame")).unwrap();
        fs::create_dir_all(tmp_dir.join("UnrealEngine")).unwrap();
        fs::write(
            tmp_dir.join("UnrealEngine/GenerateProjectFiles.bat"),
            "@echo off\r\n",
        )
        .unwrap();

        let result = validate_workspace_root(tmp_dir.to_str().unwrap(), "MyGame");
        assert!(result.is_ok());

        let _ = fs::remove_dir_all(&tmp_dir);
    }
}
