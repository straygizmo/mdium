mod commands;
mod file_watcher;
mod http_bridge;
mod markdown_parser;

use commands::active_xlsm::{new_state as new_active_xlsm_state, ActiveXlsmState};
use http_bridge::{new_state as new_http_bridge_state, HttpBridgeState};
use file_watcher::{FileWatcherState, FolderWatcherState};
use std::borrow::Cow;
use std::sync::{Arc, Mutex};
use tauri::Manager;

/// Split a HuggingFace-style model id ("org/model") into a relative path
/// (`org/model`). Shared by the RAG and speech model-directory resolvers.
pub fn model_subpath(model_name: &str) -> Result<std::path::PathBuf, String> {
    let parts: Vec<&str> = model_name.splitn(2, '/').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err(format!("Invalid model name: {}", model_name));
    }
    // Reject parent-directory traversal so a crafted model name cannot escape
    // the models base dir (the download/dir-creation paths are not behind the
    // protocol handler's canonicalize guard).
    if parts[0] == ".." || parts[1].split('/').any(|c| c == "..") {
        return Err(format!("Invalid model name: {}", model_name));
    }
    Ok(std::path::PathBuf::from(parts[0]).join(parts[1]))
}

/// Base directory that holds all downloaded/placed embedding & speech models.
/// Stored under the per-user app local data dir so it is writable regardless of
/// install location (MSI perMachine -> Program Files would otherwise be
/// read-only) and is reachable for manual model placement.
pub fn embedding_models_base_dir(
    app: &tauri::AppHandle,
) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to resolve app local data dir: {}", e))?;
    Ok(dir.join(".embedding-models"))
}

fn error_response(status: u16) -> http::Response<Cow<'static, [u8]>> {
    http::Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .body(Cow::Borrowed(&[] as &[u8]))
        .unwrap()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(Arc::new(Mutex::new(FileWatcherState::new())))
        .manage(Arc::new(Mutex::new(FolderWatcherState::new())))
        .manage::<ActiveXlsmState>(new_active_xlsm_state())
        .manage::<HttpBridgeState>(new_http_bridge_state())
        .setup(|app| {
            let icon_bytes = include_bytes!("../icons/icon.png");
            let icon = tauri::image::Image::from_bytes(icon_bytes)?;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_icon(icon.clone());
            }
            // Start local HTTP bridge for MCP server callback
            let handle = app.handle().clone();
            let bridge_state = app.state::<HttpBridgeState>().inner().clone();
            match http_bridge::start_bridge(handle, bridge_state) {
                Ok(info) => {
                    eprintln!("VBA HTTP bridge listening on 127.0.0.1:{}", info.port);
                }
                Err(e) => {
                    eprintln!("Failed to start VBA HTTP bridge: {}", e);
                }
            }
            Ok(())
        })
        .register_uri_scheme_protocol("models", |ctx, request| {
            // Handle CORS preflight
            if request.method() == "OPTIONS" {
                return http::Response::builder()
                    .status(204)
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
                    .header("Access-Control-Allow-Headers", "*")
                    .body(Cow::Borrowed(&[] as &[u8]))
                    .unwrap();
            }

            let uri = request.uri().to_string();
            // URL format on Windows: http://models.localhost/<path>
            let path = uri
                .strip_prefix("http://models.localhost/")
                .or_else(|| uri.strip_prefix("https://models.localhost/"))
                .or_else(|| uri.strip_prefix("models://localhost/"))
                .unwrap_or("");
            let decoded = percent_encoding::percent_decode_str(path)
                .decode_utf8_lossy()
                .to_string();

            let base = match embedding_models_base_dir(ctx.app_handle()) {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("models:// protocol: failed to resolve model dir: {e}");
                    return error_response(500);
                }
            };
            let file_path = base.join(&decoded);

            // Security: ensure resolved path is under base dir
            match file_path.canonicalize() {
                Ok(canonical) => {
                    if let Ok(base_canonical) = base.canonicalize() {
                        if !canonical.starts_with(&base_canonical) {
                            return error_response(403);
                        }
                    }
                }
                Err(_) => return error_response(404),
            }

            let mime = if decoded.ends_with(".json") {
                "application/json"
            } else {
                "application/octet-stream"
            };

            // HEAD requests only need the size, not the payload.
            if request.method() == "HEAD" {
                return match std::fs::metadata(&file_path) {
                    Ok(meta) => http::Response::builder()
                        .status(200)
                        .header("Content-Type", mime)
                        .header("Content-Length", meta.len().to_string())
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Cow::Borrowed(&[] as &[u8]))
                        .unwrap(),
                    Err(_) => error_response(404),
                };
            }

            match std::fs::read(&file_path) {
                Ok(data) => {
                    // Content-Length lets transformers.js pre-allocate its buffer; without it,
                    // hub.js repeatedly reallocates while streaming, which is O(N^2) in chunk count
                    // and fails for large (.onnx_data) files.
                    let len = data.len();
                    http::Response::builder()
                        .status(200)
                        .header("Content-Type", mime)
                        .header("Content-Length", len.to_string())
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Cow::Owned(data))
                        .unwrap()
                }
                Err(_) => error_response(404),
            }
        })
        .invoke_handler(tauri::generate_handler![
            // AI operations
            commands::ai::ai_test_connection,
            commands::ai::ai_chat,
            commands::ai::ai_chat_with_image,
            // File operations
            commands::file::read_text_file,
            commands::file::read_text_file_auto_encoding,
            commands::file::read_binary_file,
            commands::file::write_text_file,
            commands::file::write_text_file_with_dirs,
            commands::file::get_file_tree,
            commands::file::read_markdown_file,
            commands::file::save_markdown_file,
            commands::file::detect_zenn_project,
            commands::file::get_zenn_articles_meta,
            commands::file::open_external_url,
            commands::file::open_in_vscode,
            commands::file::rename_file,
            commands::file::delete_file,
            commands::file::create_folder,
            commands::file::folder_exists,
            commands::file::copy_file,
            commands::file::move_file,
            commands::file::open_in_default_app,
            commands::file::check_mdium_md_exists,
            // File watcher
            file_watcher::watch_file,
            file_watcher::unwatch_file,
            file_watcher::watch_folder,
            file_watcher::unwatch_folder,
            // Git operations
            commands::git::git_init,
            commands::git::git_status,
            commands::git::git_add_all,
            commands::git::git_commit,
            commands::git::git_push,
            commands::git::git_get_remote_url,
            commands::git::git_set_remote_url,
            commands::git::git_status_porcelain,
            commands::git::git_add,
            commands::git::git_restore_staged,
            commands::git::git_diff_staged,
            commands::git::git_diff_unstaged,
            commands::git::git_fetch,
            commands::git::git_log_oneline,
            commands::git::git_log_graph,
            commands::git::git_diff_commit,
            commands::git::git_branch_list,
            commands::git::git_current_branch,
            commands::git::git_switch,
            commands::git::git_discard,
            commands::git::git_remove_untracked,
            commands::git::git_push_upstream,
            commands::git::git_commits_ahead,
            commands::git::git_show_file,
            commands::git::git_clone,
            // PTY operations
            commands::pty::spawn_pty,
            commands::pty::write_to_pty,
            commands::pty::resize_pty,
            commands::pty::kill_pty,
            commands::pty::check_command_exists,
            commands::pty::install_npm_package,
            commands::pty::install_claude_code,
            commands::pty::spawn_background_process,
            commands::pty::kill_background_process,
            // Claude config operations
            commands::claude_config::get_home_dir,
            commands::claude_config::read_json_file,
            commands::claude_config::write_json_file,
            commands::claude_config::list_skills,
            commands::claude_config::write_skill,
            commands::claude_config::delete_skill,
            commands::claude_config::list_tool_files,
            commands::claude_config::write_tool_file,
            commands::claude_config::delete_tool_file,
            commands::claude_config::list_agent_files,
            commands::claude_config::write_agent_file,
            commands::claude_config::delete_agent_file,
            // RAG operations
            commands::rag::rag_get_status,
            commands::rag::rag_list_files,
            commands::rag::rag_scan_folder,
            commands::rag::rag_save_chunks,
            commands::rag::rag_search,
            commands::rag::rag_delete_index,
            commands::rag::rag_get_model_dir,
            commands::rag::rag_check_model,
            commands::rag::rag_model_required_files,
            commands::rag::rag_download_model,
            // Speech operations
            commands::speech::speech_check_model,
            commands::speech::speech_download_model,
            commands::speech::speech_get_model_dir,
            // Slidev operations
            commands::slidev::slidev_start,
            commands::slidev::slidev_sync,
            commands::slidev::slidev_export,
            commands::slidev::slidev_stop,
            commands::slidev::slidev_get_temp_dir,
            // Video operations
            commands::video::video_save_audio,
            commands::video::video_file_exists,
            commands::video::video_delete_audio_by_prefix,
            commands::video::video_clean_temp,
            commands::video::video_copy_images,
            commands::video::video_check_ffmpeg,
            commands::video::video_export,
            commands::video::video_save_project,
            commands::video::video_load_project,
            // Image generation
            commands::image_gen::gemini_generate_image,
            // MCP operations
            commands::mcp::resolve_mcp_servers_path,
            commands::mcp::mcp_test_server,
            commands::mcp::mcp_call_tool,
            // Environment variable operations
            commands::env::get_env_var,
            commands::env::set_env_var,
            // VBA macro operations
            commands::vba::extract_vba_modules,
            commands::vba::inject_vba_modules,
            commands::vba::list_vba_modules,
            // Active xlsm state
            commands::active_xlsm::set_active_xlsm_path,
            commands::active_xlsm::get_active_xlsm_path,
            commands::active_xlsm::get_http_bridge_info,
            // Medium operations
            commands::medium::medium_test_connection,
            commands::medium::medium_upload_image,
            commands::medium::medium_create_post,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::model_subpath;
    use std::path::PathBuf;

    #[test]
    fn model_subpath_splits_org_and_model() {
        assert_eq!(
            model_subpath("Xenova/multilingual-e5-base").unwrap(),
            PathBuf::from("Xenova").join("multilingual-e5-base")
        );
    }

    #[test]
    fn model_subpath_rejects_missing_slash() {
        assert!(model_subpath("no-slash").is_err());
    }

    #[test]
    fn model_subpath_rejects_traversal() {
        assert!(model_subpath("../escape").is_err());
        assert!(model_subpath("org/../escape").is_err());
    }
}
