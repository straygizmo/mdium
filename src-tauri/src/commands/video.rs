use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

fn hash_string(s: &str) -> String {
    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[tauri::command]
pub async fn video_save_audio(audio_bytes: Vec<u8>) -> Result<serde_json::Value, String> {
    let temp_dir = std::env::temp_dir().join("mdium-video").join("audio");
    fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;

    // Generate unique filename using hash of current time + data length
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let seed = format!("{}{}", now.as_nanos(), audio_bytes.len());
    let hash = hash_string(&seed);
    let file_path: PathBuf = temp_dir.join(format!("{}.wav", hash));

    fs::write(&file_path, &audio_bytes)
        .map_err(|e| format!("Failed to write audio file: {}", e))?;

    // Parse WAV header to get duration
    let duration_ms = if audio_bytes.len() >= 44 {
        let sample_rate = u32::from_le_bytes([
            audio_bytes[24],
            audio_bytes[25],
            audio_bytes[26],
            audio_bytes[27],
        ]);
        let channels = u16::from_le_bytes([audio_bytes[22], audio_bytes[23]]);
        let bits_per_sample = u16::from_le_bytes([audio_bytes[34], audio_bytes[35]]);
        let data_size = u32::from_le_bytes([
            audio_bytes[40],
            audio_bytes[41],
            audio_bytes[42],
            audio_bytes[43],
        ]);

        if sample_rate > 0 && channels > 0 && bits_per_sample > 0 {
            let bytes_per_sample = (bits_per_sample / 8) as u32;
            let total_samples = data_size / (bytes_per_sample * channels as u32);
            (total_samples as u64 * 1000 / sample_rate as u64) as u64
        } else {
            0
        }
    } else {
        0
    };

    Ok(serde_json::json!({
        "path": file_path.to_string_lossy(),
        "durationMs": duration_ms
    }))
}

#[tauri::command]
pub async fn video_clean_temp() -> Result<(), String> {
    let temp_dir = std::env::temp_dir().join("mdium-video");
    if temp_dir.exists() {
        fs::remove_dir_all(&temp_dir)
            .map_err(|e| format!("Failed to remove temp dir: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn video_copy_images(
    source_paths: Vec<String>,
    dest_dir: String,
) -> Result<(), String> {
    let dest = std::path::Path::new(&dest_dir);
    fs::create_dir_all(dest)
        .map_err(|e| format!("Failed to create dest dir: {}", e))?;

    for src_str in &source_paths {
        let src = std::path::Path::new(src_str);
        let filename = src
            .file_name()
            .ok_or_else(|| format!("Invalid source path (no filename): {}", src_str))?;
        let dest_path = dest.join(filename);
        fs::copy(src, &dest_path)
            .map_err(|e| format!("Failed to copy {} to {}: {}", src_str, dest_path.display(), e))?;
    }

    Ok(())
}
