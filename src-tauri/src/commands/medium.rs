use serde::{Deserialize, Serialize};

const MEDIUM_API_BASE: &str = "https://api.medium.com/v1";

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediumUser {
    pub id: String,
    pub username: String,
    pub name: String,
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediumPost {
    pub id: String,
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediumImage {
    pub url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePostRequest {
    pub token: String,
    pub title: String,
    pub content: String,
    pub tags: Vec<String>,
    #[serde(default)]
    pub canonical_url: String,
}

/// Test connection by fetching the authenticated user info.
#[tauri::command]
pub async fn medium_test_connection(token: String) -> Result<String, String> {
    let client = build_client()?;
    let res = client
        .get(format!("{}/me", MEDIUM_API_BASE))
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status().as_u16();
    let body = res.text().await.unwrap_or_default();

    if status < 200 || status >= 300 {
        return Err(format!("HTTP {}: {}", status, body));
    }

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("JSON parse error: {}", e))?;

    let data = &json["data"];
    let user = MediumUser {
        id: data["id"].as_str().unwrap_or("").to_string(),
        username: data["username"].as_str().unwrap_or("").to_string(),
        name: data["name"].as_str().unwrap_or("").to_string(),
        url: data["url"].as_str().unwrap_or("").to_string(),
    };

    serde_json::to_string(&user).map_err(|e| e.to_string())
}

/// Upload an image file to Medium and return the hosted URL.
#[tauri::command]
pub async fn medium_upload_image(token: String, file_path: String) -> Result<String, String> {
    let client = build_client()?;

    let file_bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("Failed to read file {}: {}", file_path, e))?;

    let file_name = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image.png")
        .to_string();

    let mime = if file_name.ends_with(".png") {
        "image/png"
    } else if file_name.ends_with(".gif") {
        "image/gif"
    } else if file_name.ends_with(".webp") {
        "image/webp"
    } else if file_name.ends_with(".tiff") || file_name.ends_with(".tif") {
        "image/tiff"
    } else {
        "image/jpeg"
    };

    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(file_name)
        .mime_str(mime)
        .map_err(|e| e.to_string())?;

    let form = reqwest::multipart::Form::new().part("image", part);

    let res = client
        .post(format!("{}/images", MEDIUM_API_BASE))
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/json")
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status().as_u16();
    let body = res.text().await.unwrap_or_default();

    if status < 200 || status >= 300 {
        return Err(format!("HTTP {}: {}", status, body));
    }

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("JSON parse error: {}", e))?;

    let url = json["data"]["url"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let img = MediumImage { url };
    serde_json::to_string(&img).map_err(|e| e.to_string())
}

/// Create a draft post on Medium.
#[tauri::command]
pub async fn medium_create_post(req: CreatePostRequest) -> Result<String, String> {
    let client = build_client()?;

    // First, get the user ID
    let me_res = client
        .get(format!("{}/me", MEDIUM_API_BASE))
        .header("Authorization", format!("Bearer {}", req.token))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let me_status = me_res.status().as_u16();
    let me_body = me_res.text().await.unwrap_or_default();

    if me_status < 200 || me_status >= 300 {
        return Err(format!("Failed to get user: HTTP {}: {}", me_status, me_body));
    }

    let me_json: serde_json::Value =
        serde_json::from_str(&me_body).map_err(|e| format!("JSON parse error: {}", e))?;

    let user_id = me_json["data"]["id"]
        .as_str()
        .ok_or("Failed to get user ID")?;

    // Create the post
    let mut post_body = serde_json::json!({
        "title": req.title,
        "contentFormat": "html",
        "content": req.content,
        "publishStatus": "draft"
    });

    if !req.tags.is_empty() {
        post_body["tags"] = serde_json::json!(req.tags);
    }

    if !req.canonical_url.is_empty() {
        post_body["canonicalUrl"] = serde_json::json!(req.canonical_url);
    }

    let res = client
        .post(format!("{}/users/{}/posts", MEDIUM_API_BASE, user_id))
        .header("Authorization", format!("Bearer {}", req.token))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .json(&post_body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status().as_u16();
    let body = res.text().await.unwrap_or_default();

    if status < 200 || status >= 300 {
        return Err(format!("HTTP {}: {}", status, body));
    }

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("JSON parse error: {}", e))?;

    let data = &json["data"];
    let post = MediumPost {
        id: data["id"].as_str().unwrap_or("").to_string(),
        url: data["url"].as_str().unwrap_or("").to_string(),
    };

    serde_json::to_string(&post).map_err(|e| e.to_string())
}
