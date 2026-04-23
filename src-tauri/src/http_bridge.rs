use rand::Rng;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::AppHandle;
use tiny_http::{Header, Response, Server};

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

fn handle_request(app: &AppHandle, expected_token: &str, request: tiny_http::Request) {
    // Placeholder: subsequent tasks add /vba/list, /vba/extract, /vba/inject routes.
    let _ = (app, expected_token, request);
    // Note: `Header` and `Response` imports are used by later tasks — suppress the
    // unused-import warning by referencing them in a no-op:
    let _ = (Header::from_bytes(b"", b"").is_ok(), Response::empty(204));
}
