use crate::error::AppError;
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
fn command_no_window(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn command_no_window(_cmd: &mut Command) {}

pub struct ProcessManager {
    active_cancel: Mutex<Option<CancellationToken>>,
    active_pids: Mutex<Vec<u32>>,
}

impl ProcessManager {
    pub fn new() -> Self {
        Self {
            active_cancel: Mutex::new(None),
            active_pids: Mutex::new(Vec::new()),
        }
    }

    pub async fn is_process_running(&self, name: &str) -> Result<bool, AppError> {
        let mut cmd = Command::new("tasklist");
        command_no_window(&mut cmd);
        let output = cmd
            .args(["/FI", &format!("IMAGENAME eq {}", name), "/NH"])
            .output()
            .await
            .map_err(AppError::ProcessSpawn)?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(stdout.contains(name))
    }

    pub async fn kill_process(&self, name: &str) -> Result<(), AppError> {
        let mut cmd = Command::new("taskkill");
        command_no_window(&mut cmd);
        let output = cmd
            .args(["/F", "/IM", name])
            .output()
            .await
            .map_err(AppError::ProcessSpawn)?;

        let stderr = String::from_utf8_lossy(&output.stderr);
        // Ignore "process not found" errors
        if !stderr.contains("not found") && !output.status.success() {
            return Err(AppError::Process(format!(
                "taskkill failed: {}",
                stderr.trim()
            )));
        }

        Ok(())
    }

    pub async fn kill_all_tracked(&self) -> Result<(), AppError> {
        let mut pids = self.active_pids.lock().await;
        let pids_to_kill: Vec<u32> = pids.drain(..).collect();

        for pid in pids_to_kill {
            let mut cmd = Command::new("taskkill");
            command_no_window(&mut cmd);
            let output = cmd
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .output()
                .await
                .map_err(AppError::ProcessSpawn)?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                eprintln!(
                    "Warning: taskkill /F /T /PID {} failed: {}",
                    pid,
                    stderr.trim()
                );
            }
        }

        let mut cancel = self.active_cancel.lock().await;
        if let Some(token) = cancel.take() {
            token.cancel();
        }

        Ok(())
    }

    pub async fn stop_all(&self) -> Result<(), AppError> {
        // Cancel the token first (stops p4_sync via tokio::select!)
        {
            let mut cancel = self.active_cancel.lock().await;
            if let Some(token) = cancel.take() {
                token.cancel();
            }
        }

        // Kill tracked PIDs (cmd.exe children, etc.)
        let mut pids = self.active_pids.lock().await;
        let pids_to_kill: Vec<u32> = pids.drain(..).collect();
        for pid in pids_to_kill {
            let mut cmd = Command::new("taskkill");
            command_no_window(&mut cmd);
            let output = cmd
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .output()
                .await
                .map_err(AppError::ProcessSpawn)?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                eprintln!(
                    "Warning: taskkill /F /T /PID {} failed: {}",
                    pid,
                    stderr.trim()
                );
            }
        }

        Ok(())
    }

    pub async fn set_cancel_token(&self, token: CancellationToken) {
        let mut cancel = self.active_cancel.lock().await;
        *cancel = Some(token);
    }

    pub async fn track_pid(&self, pid: u32) {
        let mut pids = self.active_pids.lock().await;
        pids.push(pid);
    }

    pub async fn clear_tracked(&self) {
        let mut pids = self.active_pids.lock().await;
        pids.clear();
        let mut cancel = self.active_cancel.lock().await;
        *cancel = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_track_and_clear_pids() {
        let pm = ProcessManager::new();
        pm.track_pid(1234).await;
        pm.track_pid(5678).await;

        {
            let pids = pm.active_pids.lock().await;
            assert_eq!(vec![1234u32, 5678u32], *pids);
        }

        pm.clear_tracked().await;

        {
            let pids = pm.active_pids.lock().await;
            assert!(pids.is_empty());
        }
    }

    #[tokio::test]
    async fn test_cancel_token_lifecycle() {
        let pm = ProcessManager::new();
        let token = CancellationToken::new();

        pm.set_cancel_token(token.clone()).await;
        assert!(!token.is_cancelled());

        pm.clear_tracked().await;
        // clear_tracked removes the token reference but doesn't cancel it
        assert!(!token.is_cancelled());
    }
}
