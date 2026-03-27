/// Read a user-level environment variable (current process environment).
#[tauri::command]
pub fn get_env_var(name: String) -> Result<String, String> {
    std::env::var(&name).map_err(|_| format!("Environment variable '{}' is not set", name))
}

/// Persist a user-level environment variable.
/// On Windows this calls `setx`; on Unix it is a no-op (returns error).
#[tauri::command]
pub fn set_env_var(name: String, value: String) -> Result<(), String> {
    // Also set in current process so subsequent get_env_var calls see it
    std::env::set_var(&name, &value);

    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("setx")
            .arg(&name)
            .arg(&value)
            .output()
            .map_err(|e| format!("Failed to run setx: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("setx failed: {}", stderr));
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Persistent env var setting is only supported on Windows".into())
    }
}
