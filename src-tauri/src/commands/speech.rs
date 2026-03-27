use futures_util::StreamExt;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use tauri::Emitter;

const WHISPER_SMALL_FILES: &[&str] = &[
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "preprocessor_config.json",
    "generation_config.json",
    "onnx/decoder_model_merged_quantized.onnx",
    "onnx/encoder_model_quantized.onnx",
];

const WHISPER_LARGE_V3_TURBO_FILES: &[&str] = &[
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "preprocessor_config.json",
    "generation_config.json",
    "onnx/decoder_model_merged_quantized.onnx",
    "onnx/encoder_model_quantized.onnx",
];

fn speech_model_dir_for(model_name: &str) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe.parent().ok_or("Cannot determine app directory")?;
    let parts: Vec<&str> = model_name.splitn(2, '/').collect();
    if parts.len() != 2 {
        return Err(format!("Invalid model name: {}", model_name));
    }
    Ok(exe_dir
        .join(".embedding-models")
        .join(parts[0])
        .join(parts[1]))
}

fn files_for_model(model_name: &str) -> &'static [&'static str] {
    if model_name.contains("whisper-large-v3-turbo") {
        WHISPER_LARGE_V3_TURBO_FILES
    } else {
        WHISPER_SMALL_FILES
    }
}

#[tauri::command]
pub fn speech_check_model(model_name: String) -> Result<bool, String> {
    let dir = speech_model_dir_for(&model_name)?;
    let files = files_for_model(&model_name);
    for file in files {
        if !dir.join(file).exists() {
            return Ok(false);
        }
    }
    Ok(true)
}

#[tauri::command]
pub fn speech_get_model_dir(model_name: String) -> Result<String, String> {
    let dir = speech_model_dir_for(&model_name)?;
    Ok(dir.to_string_lossy().to_string())
}

#[derive(Clone, Serialize)]
struct SpeechModelDownloadProgress {
    file: String,
    downloaded: u64,
    total: u64,
    file_index: usize,
    file_count: usize,
}

#[tauri::command]
pub async fn speech_download_model(
    app: tauri::AppHandle,
    model_name: String,
) -> Result<(), String> {
    let dir = speech_model_dir_for(&model_name)?;
    let files = files_for_model(&model_name);
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("NETWORK_ERROR:{}", e))?;
    let file_count = files.len();

    for (idx, &file) in files.iter().enumerate() {
        let target = dir.join(file);

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        let url = format!(
            "https://huggingface.co/{}/resolve/main/{}",
            model_name, file
        );

        // HEAD request to get expected file size
        let head_resp = client
            .head(&url)
            .send()
            .await
            .map_err(|e| {
                if e.is_connect() || e.is_timeout() {
                    format!("NETWORK_ERROR:{}", e)
                } else {
                    format!("DOWNLOAD_ERROR:{}", e)
                }
            })?;
        let expected_size = head_resp.content_length().unwrap_or(0);

        // Skip if file already exists with correct size
        if target.exists() {
            if let Ok(meta) = fs::metadata(&target) {
                if expected_size > 0 && meta.len() == expected_size {
                    continue;
                }
            }
        }

        let response = client
            .get(&url)
            .send()
            .await
            .map_err(|e| {
                if e.is_connect() || e.is_timeout() {
                    format!("NETWORK_ERROR:{}", e)
                } else {
                    format!("DOWNLOAD_ERROR:{}", e)
                }
            })?;

        if !response.status().is_success() {
            return Err(format!("HTTP {} for {}", response.status(), file));
        }

        let total = response.content_length().unwrap_or(0);
        let mut downloaded: u64 = 0;

        let tmp_target = target.with_extension("tmp");
        let mut out = tokio::fs::File::create(&tmp_target)
            .await
            .map_err(|e| format!("Failed to create {}: {}", file, e))?;

        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| {
                if e.is_connect() || e.is_timeout() {
                    format!("NETWORK_ERROR:{}", e)
                } else {
                    format!("DOWNLOAD_ERROR:{}", e)
                }
            })?;
            tokio::io::AsyncWriteExt::write_all(&mut out, &chunk)
                .await
                .map_err(|e| format!("Write error for {}: {}", file, e))?;
            downloaded += chunk.len() as u64;

            app.emit(
                "speech-model-download-progress",
                SpeechModelDownloadProgress {
                    file: file.to_string(),
                    downloaded,
                    total,
                    file_index: idx,
                    file_count,
                },
            )
            .ok();
        }

        drop(out);
        tokio::fs::rename(&tmp_target, &target)
            .await
            .map_err(|e| format!("Failed to finalize {}: {}", file, e))?;
    }

    Ok(())
}
