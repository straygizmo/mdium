use base64::Engine;
use serde::Deserialize;
use std::path::Path;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateImageRequest {
    pub api_key: String,
    pub model: String,
    pub prompt: String,
    pub filename: String,
    pub output_dir: String,
    pub aspect_ratio: String,
    pub image_size: String,
}

#[tauri::command]
pub async fn gemini_generate_image(req: GenerateImageRequest) -> Result<String, String> {
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
        req.model
    );

    let body = serde_json::json!({
        "contents": [{ "parts": [{ "text": req.prompt }] }],
        "generationConfig": {
            "responseModalities": ["IMAGE"],
            "imageConfig": {
                "aspectRatio": req.aspect_ratio,
                "imageSize": req.image_size
            }
        }
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("x-goog-api-key", &req.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = res.status().as_u16();
    let res_body: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if status < 200 || status >= 300 {
        let err_msg = res_body
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("Unknown error");
        return Err(format!("Gemini API error ({}): {}", status, err_msg));
    }

    // Extract base64 image data from response
    let inline_data = res_body
        .pointer("/candidates/0/content/parts")
        .and_then(|parts| parts.as_array())
        .and_then(|parts| {
            parts
                .iter()
                .find(|p| p.get("inlineData").is_some())
        })
        .and_then(|p| p.get("inlineData"))
        .ok_or("No image data in Gemini response")?;

    let b64_data = inline_data
        .get("data")
        .and_then(|d| d.as_str())
        .ok_or("No base64 data in inlineData")?;

    let mime_type = inline_data
        .get("mimeType")
        .and_then(|m| m.as_str())
        .unwrap_or("image/png");

    // Decode and save
    let image_bytes = base64::engine::general_purpose::STANDARD
        .decode(b64_data)
        .map_err(|e| format!("base64 decode error: {}", e))?;

    let dir = Path::new(&req.output_dir);
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("Failed to create output dir: {}", e))?;

    // Sanitize filename
    let safe_name = Path::new(&req.filename)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image.png");

    let file_path = dir.join(safe_name);
    tokio::fs::write(&file_path, &image_bytes)
        .await
        .map_err(|e| format!("Failed to write image: {}", e))?;

    Ok(serde_json::json!({
        "path": format!("/images/{}", safe_name),
        "absolutePath": file_path.to_string_lossy(),
        "mimeType": mime_type
    })
    .to_string())
}
