use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTestRequest {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub api_format: String, // "openai" | "anthropic" | "azure"
    #[serde(default)]
    pub azure_api_version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatRequest {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub api_format: String,
    #[serde(default)]
    pub azure_api_version: String,
    pub system_prompt: String,
    pub user_message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatWithImageRequest {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub api_format: String,
    #[serde(default)]
    pub azure_api_version: String,
    pub system_prompt: String,
    pub user_message: String,
    pub image_base64: String,
}

struct AiEndpoint {
    url: String,
    api_format: String,
}

fn build_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| e.to_string())
}

fn build_endpoint(base_url: &str, api_format: &str, azure_api_version: &str) -> AiEndpoint {
    let url = match api_format {
        "anthropic" => format!("{}/messages", base_url.trim_end_matches('/')),
        "azure" => {
            let ver = if azure_api_version.is_empty() {
                "2024-12-01-preview"
            } else {
                azure_api_version
            };
            format!(
                "{}/chat/completions?api-version={}",
                base_url.trim_end_matches('/'),
                ver
            )
        }
        _ => format!("{}/chat/completions", base_url.trim_end_matches('/')),
    };
    AiEndpoint {
        url,
        api_format: api_format.to_string(),
    }
}

fn build_request(
    client: &reqwest::Client,
    endpoint: &AiEndpoint,
    api_key: &str,
) -> reqwest::RequestBuilder {
    match endpoint.api_format.as_str() {
        "anthropic" => client
            .post(&endpoint.url)
            .header("Content-Type", "application/json")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
        "azure" => client
            .post(&endpoint.url)
            .header("Content-Type", "application/json")
            .header("api-key", api_key),
        _ => client
            .post(&endpoint.url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", api_key)),
    }
}

async fn parse_ai_response(res: reqwest::Response, api_format: &str) -> Result<String, String> {
    let status = res.status().as_u16();
    let body = res.text().await.unwrap_or_default();

    if status < 200 || status >= 300 {
        let truncated: &str = if body.len() > 500 {
            match body.char_indices().nth(500) {
                Some((idx, _)) => &body[..idx],
                None => &body,
            }
        } else {
            &body
        };
        return Err(format!("HTTP {}: {}", status, truncated));
    }

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("JSON parse error: {}", e))?;

    let text = if api_format == "anthropic" {
        json["content"][0]["text"]
            .as_str()
            .unwrap_or("")
            .to_string()
    } else {
        json["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string()
    };

    Ok(text)
}

#[tauri::command]
pub async fn ai_test_connection(req: AiTestRequest) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let res = match req.api_format.as_str() {
        "anthropic" => {
            let url = format!("{}/messages", req.base_url.trim_end_matches('/'));
            client
                .post(&url)
                .header("Content-Type", "application/json")
                .header("x-api-key", &req.api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&serde_json::json!({
                    "model": req.model,
                    "max_tokens": 16,
                    "messages": [{"role": "user", "content": "hi"}]
                }))
                .send()
                .await
                .map_err(|e| e.to_string())?
        }
        "azure" => {
            let api_version = if req.azure_api_version.is_empty() {
                "2024-12-01-preview".to_string()
            } else {
                req.azure_api_version.clone()
            };
            let url = format!(
                "{}/chat/completions?api-version={}",
                req.base_url.trim_end_matches('/'),
                api_version
            );
            client
                .post(&url)
                .header("Content-Type", "application/json")
                .header("api-key", &req.api_key)
                .json(&serde_json::json!({
                    "messages": [{"role": "user", "content": "hi"}],
                    "max_completion_tokens": 16
                }))
                .send()
                .await
                .map_err(|e| e.to_string())?
        }
        _ => {
            // OpenAI compatible
            let url = format!("{}/chat/completions", req.base_url.trim_end_matches('/'));
            client
                .post(&url)
                .header("Content-Type", "application/json")
                .header("Authorization", format!("Bearer {}", req.api_key))
                .json(&serde_json::json!({
                    "model": req.model,
                    "messages": [{"role": "user", "content": "hi"}],
                    "max_tokens": 16
                }))
                .send()
                .await
                .map_err(|e| e.to_string())?
        }
    };

    let status = res.status().as_u16();
    if status >= 200 && status < 300 {
        Ok("ok".to_string())
    } else {
        let body = res.text().await.unwrap_or_default();
        let truncated: &str = if body.len() > 200 {
            match body.char_indices().nth(200) {
                Some((idx, _)) => &body[..idx],
                None => &body,
            }
        } else {
            &body
        };
        Err(format!("{}: {}", status, truncated))
    }
}

#[tauri::command]
pub async fn ai_chat(req: AiChatRequest) -> Result<String, String> {
    let client = build_client(60)?;
    let endpoint = build_endpoint(&req.base_url, &req.api_format, &req.azure_api_version);

    let body = match req.api_format.as_str() {
        "anthropic" => serde_json::json!({
            "model": req.model,
            "max_tokens": 2048,
            "system": req.system_prompt,
            "messages": [{"role": "user", "content": req.user_message}]
        }),
        "azure" => serde_json::json!({
            "messages": [
                {"role": "system", "content": req.system_prompt},
                {"role": "user", "content": req.user_message}
            ],
            "max_completion_tokens": 2048
        }),
        _ => serde_json::json!({
            "model": req.model,
            "messages": [
                {"role": "system", "content": req.system_prompt},
                {"role": "user", "content": req.user_message}
            ],
            "max_tokens": 2048
        }),
    };

    let res = build_request(&client, &endpoint, &req.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    parse_ai_response(res, &req.api_format).await
}

#[tauri::command]
pub async fn ai_chat_with_image(req: AiChatWithImageRequest) -> Result<String, String> {
    let client = build_client(60)?;
    let endpoint = build_endpoint(&req.base_url, &req.api_format, &req.azure_api_version);

    let data_url = format!("data:image/png;base64,{}", req.image_base64);

    let body = match req.api_format.as_str() {
        "anthropic" => serde_json::json!({
            "model": req.model,
            "max_tokens": 256,
            "system": req.system_prompt,
            "messages": [{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": req.image_base64
                        }
                    },
                    {"type": "text", "text": req.user_message}
                ]
            }]
        }),
        "azure" => serde_json::json!({
            "messages": [
                {"role": "system", "content": req.system_prompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": data_url}},
                        {"type": "text", "text": req.user_message}
                    ]
                }
            ],
            "max_completion_tokens": 256
        }),
        _ => serde_json::json!({
            "model": req.model,
            "messages": [
                {"role": "system", "content": req.system_prompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": data_url}},
                        {"type": "text", "text": req.user_message}
                    ]
                }
            ],
            "max_tokens": 256
        }),
    };

    let res = build_request(&client, &endpoint, &req.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    parse_ai_response(res, &req.api_format).await
}
