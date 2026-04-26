use rand::Rng;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::AppHandle;
use tiny_http::{Header, Response, Server};

use crate::commands::active_xlsm::ActiveXlsmState;
use crate::commands::vba;
use serde::Deserialize;
use serde_json::json;
use tauri::Manager;

/// Runtime info for the local HTTP bridge. Exposed to the frontend via a Tauri command.
#[derive(Clone)]
pub struct HttpBridgeInfo {
    pub port: u16,
    pub token: String,
}

pub type HttpBridgeState = Arc<Mutex<Option<HttpBridgeInfo>>>;

pub fn new_state() -> HttpBridgeState {
    Arc::new(Mutex::new(None))
}

/// Generate a 32-character alphanumeric bearer token.
fn generate_token() -> String {
    const CHARSET: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| {
            let idx = rng.gen_range(0..CHARSET.len());
            CHARSET[idx] as char
        })
        .collect()
}

/// Start the HTTP bridge on 127.0.0.1 with an OS-chosen port.
/// Returns the listening info immediately; the server runs on a background thread.
pub fn start_bridge(
    app: AppHandle,
    state: HttpBridgeState,
) -> Result<HttpBridgeInfo, String> {
    // Bind to 127.0.0.1 with port=0 (OS-chosen)
    let server = Server::http("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind HTTP bridge: {}", e))?;
    let addr = server.server_addr();
    let port = match addr {
        tiny_http::ListenAddr::IP(a) => a.port(),
        _ => return Err("Expected IP listen address".to_string()),
    };
    let token = generate_token();

    let info = HttpBridgeInfo {
        port,
        token: token.clone(),
    };
    {
        let mut guard = state.lock().map_err(|e| format!("Lock failed: {}", e))?;
        *guard = Some(info.clone());
    }

    let expected_token = token.clone();
    thread::spawn(move || {
        for request in server.incoming_requests() {
            handle_request(&app, &expected_token, request);
        }
    });

    Ok(info)
}

#[derive(Deserialize)]
struct XlsmRequest {
    xlsm_path: String,
}

#[derive(Deserialize)]
struct InjectRequest {
    xlsm_path: String,
    macros_dir: String,
}

fn cors_headers() -> Vec<Header> {
    vec![
        Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
        Header::from_bytes(
            &b"Access-Control-Allow-Headers"[..],
            &b"Authorization, Content-Type"[..],
        )
        .unwrap(),
        Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"POST, OPTIONS"[..]).unwrap(),
        Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
    ]
}

fn json_response(status: u16, body: serde_json::Value) -> Response<std::io::Cursor<Vec<u8>>> {
    let body_bytes = body.to_string().into_bytes();
    let mut resp = Response::from_data(body_bytes).with_status_code(status);
    for h in cors_headers() {
        resp = resp.with_header(h);
    }
    resp
}

fn extract_bearer_token(request: &tiny_http::Request) -> Option<String> {
    for h in request.headers() {
        if h.field.as_str().as_str().eq_ignore_ascii_case("authorization") {
            let raw = h.value.as_str();
            if let Some(token) = raw.strip_prefix("Bearer ") {
                return Some(token.to_string());
            }
        }
    }
    None
}

fn check_active_tab(
    app: &AppHandle,
    sent_path: &str,
) -> Result<String, serde_json::Value> {
    let state = app.state::<ActiveXlsmState>();
    let guard = state.lock().map_err(|e| {
        json!({ "error": "lock_failed", "message": e.to_string() })
    })?;
    let active = guard
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();

    let same = {
        #[cfg(target_os = "windows")]
        {
            active.to_lowercase() == sent_path.to_lowercase()
        }
        #[cfg(not(target_os = "windows"))]
        {
            active == sent_path
        }
    };
    if !same {
        return Err(json!({
            "error": "active_tab_changed",
            "sentPath": sent_path,
            "activeFile": active,
            "message": "Active tab changed between resolution and operation. Retry."
        }));
    }
    Ok(active)
}

fn read_body(request: &mut tiny_http::Request) -> Result<String, String> {
    let mut body = String::new();
    request
        .as_reader()
        .read_to_string(&mut body)
        .map_err(|e| format!("Failed to read body: {}", e))?;
    Ok(body)
}

fn handle_request(app: &AppHandle, expected_token: &str, mut request: tiny_http::Request) {
    // Preflight
    if request.method() == &tiny_http::Method::Options {
        let _ = request.respond(
            Response::empty(204)
                .with_header(
                    Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
                )
                .with_header(
                    Header::from_bytes(
                        &b"Access-Control-Allow-Headers"[..],
                        &b"Authorization, Content-Type"[..],
                    )
                    .unwrap(),
                )
                .with_header(
                    Header::from_bytes(
                        &b"Access-Control-Allow-Methods"[..],
                        &b"POST, OPTIONS"[..],
                    )
                    .unwrap(),
                ),
        );
        return;
    }

    // Auth
    match extract_bearer_token(&request) {
        Some(t) if t == expected_token => {}
        _ => {
            let _ = request.respond(json_response(
                401,
                json!({ "error": "unauthorized" }),
            ));
            return;
        }
    }

    let url = request.url().to_string();
    let body_str = match read_body(&mut request) {
        Ok(b) => b,
        Err(e) => {
            let _ = request.respond(json_response(
                400,
                json!({ "error": "invalid_body", "message": e }),
            ));
            return;
        }
    };

    match url.as_str() {
        "/active-xlsm" => {
            let state = app.state::<ActiveXlsmState>();
            let guard = match state.lock() {
                Ok(g) => g,
                Err(e) => {
                    let _ = request.respond(json_response(
                        500,
                        json!({ "error": "lock_failed", "message": e.to_string() }),
                    ));
                    return;
                }
            };
            let path = guard.as_ref().map(|p| p.to_string_lossy().into_owned());
            let _ = request.respond(json_response(200, json!({ "path": path })));
        }
        "/vba/list" => {
            let req: XlsmRequest = match serde_json::from_str(&body_str) {
                Ok(r) => r,
                Err(e) => {
                    let _ = request.respond(json_response(
                        400,
                        json!({ "error": "invalid_json", "message": e.to_string() }),
                    ));
                    return;
                }
            };
            let active = match check_active_tab(app, &req.xlsm_path) {
                Ok(p) => p,
                Err(err_json) => {
                    let _ = request.respond(json_response(409, err_json));
                    return;
                }
            };
            match vba::list_vba_modules(req.xlsm_path.clone()) {
                Ok(result) => {
                    let _ = request.respond(json_response(
                        200,
                        json!({
                            "activeFile": active,
                            "macrosDir": result.macros_dir,
                            "exists": result.exists,
                            "modules": result.modules,
                        }),
                    ));
                }
                Err(e) => {
                    let _ = request.respond(json_response(
                        500,
                        json!({ "error": "list_failed", "message": e }),
                    ));
                }
            }
        }
        "/vba/extract" => {
            let req: XlsmRequest = match serde_json::from_str(&body_str) {
                Ok(r) => r,
                Err(e) => {
                    let _ = request.respond(json_response(
                        400,
                        json!({ "error": "invalid_json", "message": e.to_string() }),
                    ));
                    return;
                }
            };
            let active = match check_active_tab(app, &req.xlsm_path) {
                Ok(p) => p,
                Err(err_json) => {
                    let _ = request.respond(json_response(409, err_json));
                    return;
                }
            };
            match vba::extract_vba_modules(req.xlsm_path.clone()) {
                Ok(result) => {
                    let _ = request.respond(json_response(
                        200,
                        json!({
                            "activeFile": active,
                            "macrosDir": result.macros_dir,
                            "modules": result.modules,
                        }),
                    ));
                }
                Err(e) => {
                    let _ = request.respond(json_response(
                        500,
                        json!({ "error": "extract_failed", "message": e }),
                    ));
                }
            }
        }
        "/vba/inject" => {
            let req: InjectRequest = match serde_json::from_str(&body_str) {
                Ok(r) => r,
                Err(e) => {
                    let _ = request.respond(json_response(
                        400,
                        json!({ "error": "invalid_json", "message": e.to_string() }),
                    ));
                    return;
                }
            };
            let active = match check_active_tab(app, &req.xlsm_path) {
                Ok(p) => p,
                Err(err_json) => {
                    let _ = request.respond(json_response(409, err_json));
                    return;
                }
            };
            match vba::inject_vba_modules(req.xlsm_path.clone(), req.macros_dir.clone()) {
                Ok(result) => {
                    let _ = request.respond(json_response(
                        200,
                        json!({
                            "activeFile": active,
                            "backupPath": result.backup_path,
                            "updatedModules": result.updated_modules,
                        }),
                    ));
                }
                Err(e) => {
                    // If the error string is already structured JSON (module_set_changed),
                    // propagate with 409 so MCP clients see it distinctly.
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&e) {
                        if parsed.get("error").and_then(|v| v.as_str())
                            == Some("module_set_changed")
                        {
                            let mut augmented = parsed;
                            augmented["activeFile"] = json!(active);
                            let _ = request.respond(json_response(409, augmented));
                            return;
                        }
                    }
                    let _ = request.respond(json_response(
                        500,
                        json!({ "error": "inject_failed", "message": e }),
                    ));
                }
            }
        }
        _ => {
            let _ = request.respond(json_response(
                404,
                json!({ "error": "not_found" }),
            ));
        }
    }
}
