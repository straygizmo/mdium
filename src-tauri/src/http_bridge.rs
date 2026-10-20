use rand::Rng;
use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::AppHandle;
use tiny_http::{Header, Response, Server};

use crate::commands::fs_search::{fs_glob, fs_grep, ActiveFolderState};
use crate::commands::vba;
use serde::Deserialize;
use serde_json::json;
use tauri::{Emitter, Manager};

/// Pending RAG bridge requests, keyed by request id. The `/rag/search` handler
/// inserts a sender, emits a `rag-bridge-request` event to the webview (which
/// owns the embedding model), then blocks on the receiver. The frontend replies
/// via the `rag_bridge_respond` command, which sends the result through here.
pub type RagBridgePending = Arc<Mutex<HashMap<String, mpsc::Sender<serde_json::Value>>>>;

pub fn new_rag_pending() -> RagBridgePending {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Frontend → backend reply for a pending `/rag/search` bridge request.
#[tauri::command]
pub fn rag_bridge_respond(
    pending: tauri::State<RagBridgePending>,
    id: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    let tx = {
        let mut guard = pending.lock().map_err(|e| e.to_string())?;
        guard.remove(&id)
    };
    match tx {
        Some(tx) => {
            let _ = tx.send(payload);
            Ok(())
        }
        None => Err(format!("unknown rag bridge request id: {}", id)),
    }
}

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

/// Sidecar files carrying the bridge port/token: the opencode tool reads the
/// first, and external agents (Claude/Codex/Copilot) read `~/.mdium/bridge.json`.
fn bridge_sidecar_paths(home: &std::path::Path) -> Vec<std::path::PathBuf> {
    vec![
        home.join(".config").join("opencode").join(".mdium-bridge.json"),
        home.join(".mdium").join("bridge.json"),
    ]
}

/// Write the bridge sidecar files with the bridge port/token.
/// Best-effort: failures are ignored (the frontend also writes it on connect).
fn write_bridge_sidecar(port: u16, token: &str) {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return,
    };
    let body = format!("{{\n  \"port\": {},\n  \"token\": \"{}\"\n}}\n", port, token);
    for path in bridge_sidecar_paths(&home) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, body.as_bytes());
    }
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
        #[allow(unreachable_patterns)]
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

    // Write the sidecar the opencode rag_search tool reads, so it always points
    // at THIS run's port/token even if the user never (re)connects opencode.
    write_bridge_sidecar(port, &token);

    let expected_token = token.clone();
    thread::spawn(move || {
        for request in server.incoming_requests() {
            // Handle each request on its own thread. The /rag/search handler
            // blocks while the webview computes an embedding and runs the search,
            // so it must not stall the accept loop or the other endpoints.
            let app = app.clone();
            let token = expected_token.clone();
            thread::spawn(move || handle_request(&app, &token, request));
        }
    });

    Ok(info)
}

#[derive(Deserialize)]
struct XlsmRequest {
    xlsm_path: String,
}

/// Build the `rag-bridge-request` event payload (without `id`) for one route.
fn rag_relay_payload(kind: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
    let folder = body
        .get("folder_path")
        .and_then(|v| v.as_str())
        .ok_or("folder_path (string) is required")?;
    let approval = body
        .get("approval")
        .and_then(|v| v.as_str())
        .unwrap_or("ask");
    let mut payload = json!({ "kind": kind, "folderPath": folder });
    match kind {
        "search" => {
            let query = body
                .get("query")
                .and_then(|v| v.as_str())
                .ok_or("query (string) is required")?;
            payload["query"] = json!(query);
            payload["limit"] = body.get("limit").cloned().unwrap_or(serde_json::Value::Null);
            payload["searchMode"] = body.get("search_mode").cloned().unwrap_or(serde_json::Value::Null);
            payload["bm25Weight"] = body.get("bm25_weight").cloned().unwrap_or(serde_json::Value::Null);
        }
        "convert" => {
            let paths = body
                .get("paths")
                .and_then(|v| v.as_array())
                .filter(|a| a.iter().all(|x| x.is_string()))
                .ok_or("paths (array of strings) is required")?;
            payload["paths"] = json!(paths);
            payload["approval"] = json!(approval);
        }
        "update" => {
            payload["approval"] = json!(approval);
        }
        "status" => {}
        other => return Err(format!("unknown rag kind: {}", other)),
    }
    Ok(payload)
}

/// Map a webview reply to an HTTP status: 200 unless `ok == false`, then by error code.
pub fn rag_status_for_payload(payload: &serde_json::Value) -> u16 {
    if payload.get("ok").and_then(|v| v.as_bool()) != Some(false) {
        return 200;
    }
    match payload.get("error").and_then(|v| v.as_str()) {
        Some("job_running") => 409,
        Some("no_folder") | Some("invalid_request") => 400,
        Some("approval_denied") => 403,
        Some("approval_timeout") => 408,
        _ => 500,
    }
}

#[derive(Deserialize)]
struct GlobRequest {
    pattern: String,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct GrepRequest {
    pattern: String,
    #[serde(default)]
    include: Option<String>,
    #[serde(default)]
    case_insensitive: Option<bool>,
    #[serde(default)]
    limit: Option<usize>,
}

/// Read the live active folder, or return a ready-to-send error JSON.
fn active_folder_or_error(app: &AppHandle) -> Result<String, serde_json::Value> {
    let state = app.state::<ActiveFolderState>();
    let guard = state
        .lock()
        .map_err(|e| json!({ "ok": false, "error": format!("lock_failed: {}", e) }))?;
    match guard.as_ref() {
        Some(p) if !p.is_empty() => Ok(p.clone()),
        _ => Err(json!({
            "ok": false,
            "error": "No folder is open in mdium to search. Open a folder first."
        })),
    }
}

/// Relay one rag request to the webview (which owns the model and the index
/// jobs) and answer with its reply, mapping error codes to HTTP statuses.
fn relay_rag_request(app: &AppHandle, kind: &str, body_str: &str, request: tiny_http::Request) {
    let body: serde_json::Value = match serde_json::from_str(body_str) {
        Ok(b) => b,
        Err(e) => {
            let _ = request.respond(json_response(
                400,
                json!({ "ok": false, "error": "invalid_json", "message": e.to_string() }),
            ));
            return;
        }
    };
    let mut payload = match rag_relay_payload(kind, &body) {
        Ok(p) => p,
        Err(message) => {
            let _ = request.respond(json_response(
                400,
                json!({ "ok": false, "error": "invalid_request", "message": message }),
            ));
            return;
        }
    };

    // Register a pending slot, then ask the webview to do the work.
    let id = generate_token();
    payload["id"] = json!(id);
    let (tx, rx) = mpsc::channel::<serde_json::Value>();
    let pending: RagBridgePending = app.state::<RagBridgePending>().inner().clone();
    match pending.lock() {
        Ok(mut g) => {
            g.insert(id.clone(), tx);
        }
        Err(e) => {
            let _ = request.respond(json_response(
                500,
                json!({ "ok": false, "error": format!("lock_failed: {}", e) }),
            ));
            return;
        }
    }

    if app.emit("rag-bridge-request", payload).is_err() {
        if let Ok(mut g) = pending.lock() {
            g.remove(&id);
        }
        let _ = request.respond(json_response(
            500,
            json!({ "ok": false, "error": "failed to reach mdium webview" }),
        ));
        return;
    }

    // Block this request's thread until the webview replies or times out.
    // First call loads the embedding model, which can take a while.
    match rx.recv_timeout(Duration::from_secs(180)) {
        Ok(value) => {
            let status = rag_status_for_payload(&value);
            let _ = request.respond(json_response(status, value));
        }
        Err(_) => {
            if let Ok(mut g) = pending.lock() {
                g.remove(&id);
            }
            let _ = request.respond(json_response(
                504,
                json!({ "ok": false, "error": "mdium did not respond (timeout). Is the RAG model available?" }),
            ));
        }
    }
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpBridgeClientInfo {
    pub port: u16,
    pub token: String,
}

#[tauri::command]
pub fn get_http_bridge_info(state: tauri::State<'_, HttpBridgeState>) -> Result<Option<HttpBridgeClientInfo>, String> {
    let guard = state.lock().map_err(|e| format!("Failed to lock HTTP bridge state: {}", e))?;
    Ok(guard.as_ref().map(|i| HttpBridgeClientInfo { port: i.port, token: i.token.clone() }))
}

/// Absolute paths pass through; relative ones resolve against the open folder.
pub fn resolve_xlsm_path(raw: &str, active_folder: Option<&str>) -> Result<String, String> {
    let p = std::path::Path::new(raw);
    if p.is_absolute() {
        return Ok(raw.to_string());
    }
    match active_folder {
        Some(folder) if !folder.is_empty() => Ok(std::path::Path::new(folder).join(p).to_string_lossy().into_owned()),
        _ => Err(vba::vba_error("no_active_folder", "Relative xlsm_path given but no folder is open in mdium. Pass an absolute path.")),
    }
}

pub fn status_for_vba_error(code: &str) -> u16 {
    match code {
        "workbook_locked" => 409,
        c if c.ends_with("_failed") => 500,
        _ => 400,
    }
}

/// Turn a command error string into (status, json body). Command errors are
/// `vba_error` JSON; anything else is wrapped as `<route>_failed`.
pub fn vba_error_response(route: &str, err: String) -> (u16, serde_json::Value) {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&err) {
        if let Some(code) = v.get("error").and_then(|c| c.as_str()) {
            return (status_for_vba_error(code), v.clone());
        }
    }
    (500, json!({ "error": format!("{}_failed", route), "message": err }))
}

fn handle_vba_route(app: &AppHandle, route: &str, body_str: &str) -> (u16, serde_json::Value) {
    let req: XlsmRequest = match serde_json::from_str(body_str) {
        Ok(r) => r,
        Err(e) => return (400, json!({ "error": "invalid_json", "message": e.to_string() })),
    };
    let folder = app.state::<ActiveFolderState>().lock().ok().and_then(|g| g.clone());
    let path = match resolve_xlsm_path(&req.xlsm_path, folder.as_deref()) {
        Ok(p) => p,
        Err(e) => return vba_error_response(route, e),
    };
    let result: Result<serde_json::Value, String> = match route {
        "list" => vba::list_vba_modules(path.clone()).map(|r| serde_json::to_value(r).unwrap_or_default()),
        "pull" => vba::pull_vba_modules(path.clone()).map(|r| serde_json::to_value(r).unwrap_or_default()),
        "push" => vba::push_vba_modules_impl(&path).map(|r| {
            let _ = app.emit("vba-pushed", json!({ "path": path }));
            serde_json::to_value(r).unwrap_or_default()
        }),
        _ => Err("unknown route".to_string()),
    };
    match result {
        Ok(v) => (200, v),
        Err(e) => vba_error_response(route, e),
    }
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
        "/vba/list" | "/vba/pull" | "/vba/push" => {
            let route = url.trim_start_matches("/vba/");
            let (status, body) = handle_vba_route(app, route, &body_str);
            let _ = request.respond(json_response(status, body));
        }
        "/rag/search" | "/rag/status" | "/rag/convert" | "/rag/update" => {
            let kind = url.trim_start_matches("/rag/");
            relay_rag_request(app, kind, &body_str, request);
        }
        "/glob" => {
            let req: GlobRequest = match serde_json::from_str(&body_str) {
                Ok(r) => r,
                Err(e) => {
                    let _ = request.respond(json_response(
                        400,
                        json!({ "ok": false, "error": format!("invalid_json: {}", e) }),
                    ));
                    return;
                }
            };
            let folder = match active_folder_or_error(app) {
                Ok(f) => f,
                Err(err_json) => {
                    let _ = request.respond(json_response(400, err_json));
                    return;
                }
            };
            let limit = req.limit.unwrap_or(1000).min(5000);
            match fs_glob(std::path::Path::new(&folder), &req.pattern, limit) {
                Ok(files) => {
                    let _ = request.respond(json_response(
                        200,
                        json!({ "ok": true, "folder": folder, "files": files }),
                    ));
                }
                Err(e) => {
                    let _ = request.respond(json_response(
                        200,
                        json!({ "ok": false, "error": e }),
                    ));
                }
            }
        }
        "/grep" => {
            let req: GrepRequest = match serde_json::from_str(&body_str) {
                Ok(r) => r,
                Err(e) => {
                    let _ = request.respond(json_response(
                        400,
                        json!({ "ok": false, "error": format!("invalid_json: {}", e) }),
                    ));
                    return;
                }
            };
            let folder = match active_folder_or_error(app) {
                Ok(f) => f,
                Err(err_json) => {
                    let _ = request.respond(json_response(400, err_json));
                    return;
                }
            };
            let limit = req.limit.unwrap_or(500).min(2000);
            match fs_grep(
                std::path::Path::new(&folder),
                &req.pattern,
                req.include.as_deref(),
                req.case_insensitive.unwrap_or(false),
                limit,
            ) {
                Ok(matches) => {
                    let _ = request.respond(json_response(
                        200,
                        json!({ "ok": true, "folder": folder, "matches": matches }),
                    ));
                }
                Err(e) => {
                    let _ = request.respond(json_response(
                        200,
                        json!({ "ok": false, "error": e }),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_paths_pass_through() {
        assert_eq!(resolve_xlsm_path("C:/w/Book.xlsm", None).unwrap(), "C:/w/Book.xlsm");
        assert_eq!(resolve_xlsm_path("C:\\w\\Book.xlsm", Some("D:/x")).unwrap(), "C:\\w\\Book.xlsm");
    }

    #[test]
    fn relative_paths_resolve_against_the_active_folder() {
        let p = resolve_xlsm_path("sub/Book.xlsm", Some("C:/w")).unwrap();
        assert_eq!(std::path::Path::new(&p), std::path::Path::new("C:/w").join("sub/Book.xlsm"));
    }

    #[test]
    fn relative_path_without_folder_is_an_error() {
        let err = resolve_xlsm_path("Book.xlsm", None).unwrap_err();
        assert!(err.contains("no_active_folder"));
    }

    #[test]
    fn status_codes_follow_error_code() {
        assert_eq!(status_for_vba_error("workbook_locked"), 409);
        assert_eq!(status_for_vba_error("push_failed"), 500);
        assert_eq!(status_for_vba_error("list_failed"), 500);
        assert_eq!(status_for_vba_error("invalid_module_name"), 400);
        assert_eq!(status_for_vba_error("no_vba_project"), 400);
    }

    #[test]
    fn non_json_errors_become_500_with_route_code() {
        let (status, body) = vba_error_response("push", "boom".to_string());
        assert_eq!(status, 500);
        assert_eq!(body["error"], "push_failed");
        assert_eq!(body["message"], "boom");
    }

    #[test]
    fn json_errors_keep_their_code() {
        let (status, body) = vba_error_response("push", vba::vba_error("workbook_locked", "open"));
        assert_eq!(status, 409);
        assert_eq!(body["error"], "workbook_locked");
    }

    #[test]
    fn rag_status_codes_follow_error_code() {
        assert_eq!(rag_status_for_payload(&json!({"ok": true, "results": []})), 200);
        assert_eq!(rag_status_for_payload(&json!({"ok": false, "error": "job_running"})), 409);
        assert_eq!(rag_status_for_payload(&json!({"ok": false, "error": "no_folder"})), 400);
        assert_eq!(rag_status_for_payload(&json!({"ok": false, "error": "approval_denied"})), 403);
        assert_eq!(rag_status_for_payload(&json!({"ok": false, "error": "approval_timeout"})), 408);
        assert_eq!(rag_status_for_payload(&json!({"ok": false, "error": "boom"})), 500);
    }

    #[test]
    fn rag_relay_payload_camel_cases_each_kind() {
        let p = rag_relay_payload("convert", &json!({"folder_path":"C:/w","paths":["a.docx"],"approval":"ask"})).unwrap();
        assert_eq!(p["kind"], "convert");
        assert_eq!(p["folderPath"], "C:/w");
        assert_eq!(p["paths"][0], "a.docx");
        assert_eq!(p["approval"], "ask");
        let p = rag_relay_payload("search", &json!({"folder_path":"C:/w","query":"q","bm25_weight":0.3})).unwrap();
        assert_eq!(p["query"], "q");
        assert_eq!(p["bm25Weight"], 0.3);
        assert!(p["limit"].is_null());
        assert!(rag_relay_payload("convert", &json!({"folder_path":"C:/w"})).is_err()); // paths required
        assert!(rag_relay_payload("status", &json!({"folder_path":"C:/w"})).is_ok());
    }

    #[test]
    fn bridge_sidecar_paths_include_mdium_home() {
        let paths = bridge_sidecar_paths(std::path::Path::new("H"));
        assert!(paths.iter().any(|p| p.ends_with(std::path::Path::new(".mdium/bridge.json"))));
        assert!(paths.iter().any(|p| p.ends_with(std::path::Path::new(".config/opencode/.mdium-bridge.json"))));
    }
}
