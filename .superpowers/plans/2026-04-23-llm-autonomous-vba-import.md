# LLM 自律的 VBA マクロ取り込み Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MDium 内の opencode チャットから LLM が VBA マクロを自律的に `extract` / 編集 / `import` できるようにする。MDium バンドルの新規 MCP サーバー `mdium-vba` 経由でツール提供し、各ツール呼び出しの瞬間のアクティブタブを対象に動作する（active-tab-dynamic）。

**Architecture:** Node.js 製の MCP サーバー `mdium-vba` を `resources/mcp-servers/` にバンドル。トグル ON 時、MDium が opencode config に `mdium-vba` エントリ（port/token 込み）を書き込む（MDium 起動のたびに書き換え）。MCP サーバーは各ツール呼び出し時に `GET /active-xlsm` で現在のアクティブタブを取得し、`/vba/*` エンドポイント経由で既存の `extract_vba_modules` / `inject_vba_modules` を呼ぶ。コンテキスト誤認防止は L1（送信メッセージに `<mdium_context>` でアクティブタブ注入）+ L2（ツール応答に `activeFile` を同梱、LLM 側で `<mdium_context>` と整合確認）+ HTTP 層の race 検出（`active_tab_changed` 409）。

**Tech Stack:** Rust (`tiny_http`, `serde_json`, 既存の `zip`/`cfb`/`encoding_rs`), Node.js (`@modelcontextprotocol/sdk`, `zod`), TypeScript/React, Tauri IPC

**Spec:** `.superpowers/specs/2026-04-23-llm-autonomous-vba-import-design.md`

---

## File Structure

### New Files (Rust)
- `src-tauri/src/http_bridge.rs` — ローカルループバック HTTP サーバー。トークン認証。`/vba/list`, `/vba/extract`, `/vba/inject` エンドポイント。
- `src-tauri/src/active_xlsm_state.rs` — アクティブタブの xlsm 絶対パスを保持する共有状態（`Arc<Mutex<Option<PathBuf>>>`）。HTTP bridge とフロントエンドで共有。

### Modified Files (Rust)
- `src-tauri/Cargo.toml` — `tiny_http`, `rand` 依存追加
- `src-tauri/src/lib.rs` — HTTP bridge 起動、state 登録、新コマンド登録
- `src-tauri/src/commands/mod.rs` — `pub mod active_xlsm;` 追加（新コマンドモジュール）
- `src-tauri/src/commands/active_xlsm.rs` — アクティブタブ更新/取得の Tauri コマンド、HTTP 起動情報取得コマンド
- `src-tauri/src/commands/vba.rs` — (a) strict モジュール構成検出追加、(b) 新規 `list_vba_modules` Tauri コマンド追加

### New Files (Node MCP Server)
- `resources/mcp-servers/mdium-vba/package.json`
- `resources/mcp-servers/mdium-vba/tsconfig.json`
- `resources/mcp-servers/mdium-vba/src/index.ts` — MCP サーバーのエントリ、3 ツール定義
- `resources/mcp-servers/mdium-vba/src/http-client.ts` — MDium ローカル HTTP へのリレー fetch ラッパ
- `resources/mcp-servers/mdium-vba/.gitignore` — `dist/`, `node_modules/`

### Modified Files (Frontend)
- `src/stores/settings-store.ts` — `allowLlmVbaImport: boolean` フィールド追加
- `src/features/opencode-config/lib/builtin-mcp-servers.ts` — `mdium-vba` 登録
- `src/features/opencode-config/lib/builtin-skills.ts` — `vba-coding-conventions` に MDium フロー節を条件付きで追加
- `src/features/opencode-config/hooks/useOpencodeChat.ts` — 送信メッセージの `<mdium_context>` ラップ、MCP サーバー起動時 env var 注入
- `src/features/preview/components/PreviewPanel.tsx` — トグル UI、アクティブタブ xlsm パス通知、import 後の binaryData 再読込共通化
- `src/shared/i18n/locales/ja/editor.json` — 新 i18n キー（トグル、module_set_changed）
- `src/shared/i18n/locales/en/editor.json` — 同上

---

## Task 1: Rust 依存クレート追加

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Cargo.toml に依存追加**

`src-tauri/Cargo.toml` の `[dependencies]` セクション末尾（`encoding_rs = "0.8"` の後）に追加:

```toml
tiny_http = "0.12"
rand = "0.8"
```

- [ ] **Step 2: ビルド確認**

Run: `cd src-tauri && cargo check`
Expected: コンパイル成功（警告のみ許容）

- [ ] **Step 3: コミット**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore(deps): add tiny_http and rand for VBA HTTP bridge"
```

---

## Task 2: inject_vba_modules に strict モジュール構成検出を追加

`inject_vba_modules` が実処理に入る前に、`_macros/` 内のファイル集合と `vbaProject.bin` 内のモジュール集合を比較し、不一致があれば書き込みを行わずエラーを返す。

**Files:**
- Modify: `src-tauri/src/commands/vba.rs`

- [ ] **Step 1: 失敗するテストを追加**

`src-tauri/src/commands/vba.rs` 末尾の `mod tests` 内の最後のテスト関数の後に追加:

```rust
    #[test]
    fn test_inject_error_new_in_files() {
        // Given: macros_dir has Module1.bas and a NEW Module2.bas
        // When: inject_vba_modules is called
        // Then: returns JSON error with error="module_set_changed" and newInFiles includes "Module2"
        let tmp = std::env::temp_dir().join(format!("mdium_vba_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let xlsm_path = tmp.join("Book1.xlsm");
        let macros_dir = tmp.join("Book1_macros");
        std::fs::create_dir_all(&macros_dir).unwrap();

        // Use a real xlsm fixture that has exactly Module1 defined.
        // (We reuse the fixture from test_extract_roundtrip if it exists, else skip.)
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("minimal_macro.xlsm");
        if !fixture.exists() {
            eprintln!("Skipping test: fixture {:?} missing", fixture);
            return;
        }
        std::fs::copy(&fixture, &xlsm_path).unwrap();
        std::fs::write(macros_dir.join("Module1.bas"), b"Attribute VB_Name = \"Module1\"\r\nSub A()\r\nEnd Sub\r\n").unwrap();
        std::fs::write(macros_dir.join("Module2.bas"), b"Attribute VB_Name = \"Module2\"\r\nSub B()\r\nEnd Sub\r\n").unwrap();

        let err = inject_vba_modules(
            xlsm_path.to_string_lossy().to_string(),
            macros_dir.to_string_lossy().to_string(),
        )
        .err()
        .expect("expected error for added module");

        assert!(err.contains("\"error\":\"module_set_changed\""), "got: {}", err);
        assert!(err.contains("\"newInFiles\""), "got: {}", err);
        assert!(err.contains("Module2"), "got: {}", err);

        // xlsm must NOT have been modified (no .bak created either)
        let bak = xlsm_path.with_extension("xlsm.bak");
        assert!(!bak.exists(), "backup was created for a refused inject");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_inject_error_missing_in_files() {
        // Given: vbaProject.bin has Module1 and Module2, but macros_dir only has Module1.bas
        let tmp = std::env::temp_dir().join(format!("mdium_vba_test_miss_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("two_module.xlsm");
        if !fixture.exists() {
            eprintln!("Skipping test: fixture {:?} missing", fixture);
            return;
        }
        let xlsm_path = tmp.join("Book2.xlsm");
        std::fs::copy(&fixture, &xlsm_path).unwrap();

        let macros_dir = tmp.join("Book2_macros");
        std::fs::create_dir_all(&macros_dir).unwrap();
        std::fs::write(macros_dir.join("Module1.bas"), b"Attribute VB_Name = \"Module1\"\r\nSub A()\r\nEnd Sub\r\n").unwrap();

        let err = inject_vba_modules(
            xlsm_path.to_string_lossy().to_string(),
            macros_dir.to_string_lossy().to_string(),
        )
        .err()
        .expect("expected error for missing module");

        assert!(err.contains("\"error\":\"module_set_changed\""), "got: {}", err);
        assert!(err.contains("\"missingInFiles\""), "got: {}", err);
        assert!(err.contains("Module2"), "got: {}", err);

        let _ = std::fs::remove_dir_all(&tmp);
    }
```

- [ ] **Step 2: テスト失敗を確認**

Run: `cd src-tauri && cargo test --lib commands::vba::tests::test_inject_error -- --nocapture`
Expected: 両テストが FAIL（fixture が無ければ `return` で skip になるので、その場合は fixture を用意する必要がある。fixture 未作成時は次ステップで作成）

- [ ] **Step 3: テスト fixture を準備**

**注意:** `.xlsm` はバイナリなので人手で作れない。既存の手動テスト済みファイルがあればそれを使い、無ければ最初は fixture を空置きしてこの 2 テストは `fixture.exists()` でスキップされる状態のままにする（テスト用 xlsm は後続の E2E で用意する方針）。

fixture 用ディレクトリのみ作成:

```bash
mkdir -p src-tauri/tests/fixtures
touch src-tauri/tests/fixtures/.gitkeep
```

- [ ] **Step 4: バックアップ作成を strict 検査の後に移動**

既存 `inject_vba_modules` の `// 3. Create backup` ブロックを削除（バックアップは strict 検査を通過した後に作る）:

削除対象（現状の 851-854 行目あたり）:
```rust
    // 3. Create backup
    let backup_path = format!("{}.bak", xlsm_path);
    fs::copy(&xlsm_path, &backup_path)
        .map_err(|e| format!("Failed to create backup: {}", e))?;
```

- [ ] **Step 5: strict 検査を挿入**

既存の `let project = parse_dir_stream(&dir_data)?;` の直後、`// Build mappings:` の前に以下を挿入:

```rust
    // 5.5. Strict module-set check: refuse if _macros/ and vbaProject.bin disagree.
    //      Matches on dir-stream module name only (not stream_name, not VB_Name).
    //      This mirrors the public-facing file naming used by extract_vba_modules.
    {
        let macros_names: std::collections::HashSet<String> =
            macro_files.iter().map(|(n, _)| n.clone()).collect();
        let project_names: std::collections::HashSet<String> =
            project.modules.iter().map(|m| m.name.clone()).collect();

        let mut new_in_files: Vec<String> = macros_names
            .difference(&project_names)
            .cloned()
            .collect();
        let mut missing_in_files: Vec<String> = project_names
            .difference(&macros_names)
            .cloned()
            .collect();
        new_in_files.sort();
        missing_in_files.sort();

        if !new_in_files.is_empty() || !missing_in_files.is_empty() {
            let payload = serde_json::json!({
                "error": "module_set_changed",
                "newInFiles": new_in_files,
                "missingInFiles": missing_in_files,
                "message": "Adding or removing modules is not supported. Revert the additions/deletions, or ask the user to add/remove modules in Excel's VBE first, then re-run extract_vba_modules."
            });
            return Err(payload.to_string());
        }
    }

    // 5.6. Strict check passed; now safe to create backup.
    let backup_path = format!("{}.bak", xlsm_path);
    fs::copy(&xlsm_path, &backup_path)
        .map_err(|e| format!("Failed to create backup: {}", e))?;
```

- [ ] **Step 6: `serde_json` を vba.rs で使えるようにする**

`src-tauri/src/commands/vba.rs` の冒頭 use 宣言に追加:

```rust
use serde_json;
```

すでに crate 全体で依存としてあるので追加インポート不要かもしれない。ビルド時に未インポートエラーが出たら上記を追加。

- [ ] **Step 7: ビルド・既存テスト確認**

Run: `cd src-tauri && cargo check`
Expected: コンパイル成功

Run: `cd src-tauri && cargo test --lib commands::vba::tests`
Expected: 既存テスト（圧縮解凍/エンコーディング等）が全部 PASS、新規 2 テストは fixture 不在で skip

- [ ] **Step 8: コミット**

```bash
git add src-tauri/src/commands/vba.rs src-tauri/tests/fixtures/.gitkeep
git commit -m "feat(vba): add strict module-set check to inject_vba_modules"
```

---

## Task 3: 新規 list_vba_modules Tauri コマンドを追加

extract の読み取り部分（ZIP + dir stream 解析）だけを行い、ファイル書き出しなし。`_macros/` の存在チェックと合わせて返す。

**Files:**
- Modify: `src-tauri/src/commands/vba.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 新規戻り値型を vba.rs に追加**

`src-tauri/src/commands/vba.rs` の既存 `InjectResult` 構造体の後に追加:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub macros_dir: String,
    pub exists: bool,
    pub modules: Vec<VbaModule>,
}
```

- [ ] **Step 2: list_vba_modules コマンドを実装**

`src-tauri/src/commands/vba.rs` の末尾 `#[cfg(test)]` ブロックの直前に追加:

```rust
// ---------------------------------------------------------------------------
// Command: list_vba_modules
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_vba_modules(xlsm_path: String) -> Result<ListResult, String> {
    let path = Path::new(&xlsm_path);
    if !path.exists() {
        return Err(format!("File not found: {}", xlsm_path));
    }

    // Derive macros_dir from xlsm path ({stem}_macros/)
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("Invalid file name")?;
    let parent = path
        .parent()
        .ok_or("Cannot determine parent directory")?;
    let macros_dir = parent.join(format!("{}_macros", stem));
    let exists = macros_dir.exists() && macros_dir.is_dir();

    // Read vbaProject.bin and parse dir stream (same as extract, but no writes)
    let file = fs::File::open(&xlsm_path)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read ZIP archive: {}", e))?;

    let vba_bin = {
        let mut entry = archive
            .by_name("xl/vbaProject.bin")
            .map_err(|_| "No VBA macros found in this file (xl/vbaProject.bin not present)".to_string())?;
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf)
            .map_err(|e| format!("Failed to read vbaProject.bin: {}", e))?;
        buf
    };

    let mut comp = cfb::CompoundFile::open(Cursor::new(&vba_bin))
        .map_err(|e| format!("Failed to parse vbaProject.bin as OLE2: {}", e))?;

    let mut dir_compressed = Vec::new();
    comp.open_stream("/VBA/dir")
        .map_err(|e| format!("Failed to open /VBA/dir stream: {}", e))?
        .read_to_end(&mut dir_compressed)
        .map_err(|e| format!("Failed to read /VBA/dir stream: {}", e))?;

    let dir_data = vba_decompress(&dir_compressed)?;
    let project = parse_dir_stream(&dir_data)?;

    // Build module list. path is only populated when the extracted file exists.
    let modules: Vec<VbaModule> = project
        .modules
        .iter()
        .map(|m| {
            let (ext, type_str) = if m.module_type == 0x21 {
                (".bas", "standard")
            } else {
                let lower = m.name.to_lowercase();
                if lower.starts_with("sheet") || lower == "thisworkbook" {
                    (".cls", "document")
                } else {
                    (".cls", "class")
                }
            };
            let file_path = macros_dir.join(format!("{}{}", m.name, ext));
            let path_str = if file_path.exists() {
                file_path.to_string_lossy().into_owned()
            } else {
                String::new()
            };
            VbaModule {
                name: m.name.clone(),
                module_type: type_str.to_string(),
                path: path_str,
            }
        })
        .collect();

    Ok(ListResult {
        macros_dir: macros_dir.to_string_lossy().into_owned(),
        exists,
        modules,
    })
}
```

- [ ] **Step 3: Tauri コマンド登録**

`src-tauri/src/lib.rs:237-238`（`// VBA macro operations` セクション）を以下に変更:

```rust
            // VBA macro operations
            commands::vba::extract_vba_modules,
            commands::vba::inject_vba_modules,
            commands::vba::list_vba_modules,
```

- [ ] **Step 4: ビルド確認**

Run: `cd src-tauri && cargo check`
Expected: コンパイル成功

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/commands/vba.rs src-tauri/src/lib.rs
git commit -m "feat(vba): add list_vba_modules command for read-only enumeration"
```

---

## Task 4: アクティブ xlsm 状態管理モジュール

HTTP bridge が「現在のアクティブタブの xlsm 絶対パス」を参照できるよう、`Arc<Mutex<Option<PathBuf>>>` で共有状態を保持。フロントエンドからは Tauri コマンドで更新。

**Files:**
- Create: `src-tauri/src/commands/active_xlsm.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: active_xlsm モジュールを作成**

`src-tauri/src/commands/active_xlsm.rs` を新規作成:

```rust
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::State;

/// Shared state tracking which xlsm is currently previewed in the active tab.
/// `None` means the active tab is not an xlsm/xlam (or no tab is active).
pub type ActiveXlsmState = Arc<Mutex<Option<PathBuf>>>;

pub fn new_state() -> ActiveXlsmState {
    Arc::new(Mutex::new(None))
}

#[tauri::command]
pub fn set_active_xlsm_path(
    path: Option<String>,
    state: State<'_, ActiveXlsmState>,
) -> Result<(), String> {
    let mut guard = state
        .lock()
        .map_err(|e| format!("Failed to lock active xlsm state: {}", e))?;
    *guard = path.map(PathBuf::from);
    Ok(())
}

#[tauri::command]
pub fn get_active_xlsm_path(
    state: State<'_, ActiveXlsmState>,
) -> Result<Option<String>, String> {
    let guard = state
        .lock()
        .map_err(|e| format!("Failed to lock active xlsm state: {}", e))?;
    Ok(guard.as_ref().map(|p| p.to_string_lossy().into_owned()))
}
```

- [ ] **Step 2: mod.rs に登録**

`src-tauri/src/commands/mod.rs` に追加（モジュール宣言の順序に挿入、例えば `pub mod vba;` の直後）:

```rust
pub mod active_xlsm;
```

- [ ] **Step 3: lib.rs に state 登録**

`src-tauri/src/lib.rs` を以下のように修正:

（a）`use file_watcher::{FileWatcherState, FolderWatcherState};` の直後に追加:
```rust
use commands::active_xlsm::{new_state as new_active_xlsm_state, ActiveXlsmState};
```

（b）`.manage(Arc::new(Mutex::new(FolderWatcherState::new())))` の直後に追加:
```rust
        .manage::<ActiveXlsmState>(new_active_xlsm_state())
```

（c）`invoke_handler` の `// VBA macro operations` ブロックの直後に新セクション追加:
```rust
            // Active xlsm state
            commands::active_xlsm::set_active_xlsm_path,
            commands::active_xlsm::get_active_xlsm_path,
```

- [ ] **Step 4: ビルド確認**

Run: `cd src-tauri && cargo check`
Expected: コンパイル成功

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/commands/active_xlsm.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(vba): add active xlsm path shared state and commands"
```

---

## Task 5: ローカル HTTP bridge の骨格（トークン生成 + listen）

`tiny_http` で `127.0.0.1` に listen する HTTP サーバーを別スレッドで起動。ポートは OS に選ばせる。セッショントークンを起動時にランダム生成し、state として保持。

**Files:**
- Create: `src-tauri/src/http_bridge.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: http_bridge.rs を作成**

`src-tauri/src/http_bridge.rs` を新規作成:

```rust
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
}
```

- [ ] **Step 2: lib.rs で起動**

`src-tauri/src/lib.rs` を以下のように修正:

（a）`mod markdown_parser;` の直後に追加:
```rust
mod http_bridge;
```

（b）`use commands::active_xlsm::{new_state as new_active_xlsm_state, ActiveXlsmState};` の直後に追加:
```rust
use http_bridge::{new_state as new_http_bridge_state, HttpBridgeState};
```

（c）`.manage::<ActiveXlsmState>(new_active_xlsm_state())` の直後に追加:
```rust
        .manage::<HttpBridgeState>(new_http_bridge_state())
```

（d）`setup` クロージャ内、`Ok(())` の直前に以下を追加:
```rust
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
```

- [ ] **Step 3: ビルド確認**

Run: `cd src-tauri && cargo check`
Expected: コンパイル成功。未使用変数警告は一旦 OK。

- [ ] **Step 4: 起動スモーク確認**

Run: `cd C:/Users/mtmar/source/repos/mdium && npm run tauri dev`
Expected: アプリ起動、標準出力に `VBA HTTP bridge listening on 127.0.0.1:<port>` が出力される。Ctrl+C で停止。

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/http_bridge.rs src-tauri/src/lib.rs
git commit -m "feat(vba): scaffold local HTTP bridge with token auth"
```

---

## Task 6: HTTP bridge info を返す Tauri コマンド

フロントエンドから「MCP サーバー起動に必要なポートとトークン」を取得するコマンドを追加。

**Files:**
- Modify: `src-tauri/src/commands/active_xlsm.rs`
- Modify: `src-tauri/src/lib.rs`

実装上は active_xlsm モジュールとは別の方が整理できるが、小粒なので同モジュールに共存させる。

- [ ] **Step 1: active_xlsm.rs に追加**

`src-tauri/src/commands/active_xlsm.rs` の末尾に追加:

```rust
use crate::http_bridge::{HttpBridgeInfo, HttpBridgeState};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpBridgeClientInfo {
    pub port: u16,
    pub token: String,
}

#[tauri::command]
pub fn get_http_bridge_info(
    state: State<'_, HttpBridgeState>,
) -> Result<Option<HttpBridgeClientInfo>, String> {
    let guard = state
        .lock()
        .map_err(|e| format!("Failed to lock HTTP bridge state: {}", e))?;
    Ok(guard.as_ref().map(|info: &HttpBridgeInfo| HttpBridgeClientInfo {
        port: info.port,
        token: info.token.clone(),
    }))
}
```

- [ ] **Step 2: lib.rs にコマンド登録**

`src-tauri/src/lib.rs` の `// Active xlsm state` ブロックを以下に変更:

```rust
            // Active xlsm state
            commands::active_xlsm::set_active_xlsm_path,
            commands::active_xlsm::get_active_xlsm_path,
            commands::active_xlsm::get_http_bridge_info,
```

- [ ] **Step 3: ビルド確認**

Run: `cd src-tauri && cargo check`
Expected: コンパイル成功

- [ ] **Step 4: コミット**

```bash
git add src-tauri/src/commands/active_xlsm.rs src-tauri/src/lib.rs
git commit -m "feat(vba): expose http bridge info to frontend"
```

---

## Task 7: HTTP bridge のルーティングと認証

`/active-xlsm`, `/vba/list`, `/vba/extract`, `/vba/inject` のルートを実装。bearer token 検証。`sentPath` と `activeFile` の race 検出で 409 `active_tab_changed` を返す。

**Files:**
- Modify: `src-tauri/src/http_bridge.rs`

- [ ] **Step 1: リクエスト処理の実装**

`src-tauri/src/http_bridge.rs` の `handle_request` と import 部分を以下で全置換（ファイル末尾まで）:

```rust
use crate::commands::active_xlsm::ActiveXlsmState;
use crate::commands::vba;
use serde::Deserialize;
use serde_json::json;
use std::io::Read;
use tauri::Manager;

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
```

- [ ] **Step 2: ビルド確認**

Run: `cd src-tauri && cargo check`
Expected: コンパイル成功

- [ ] **Step 3: curl による動作確認（オプション）**

アプリ起動後、別ターミナルで:

```bash
# Get port and token from the app logs
curl -X POST "http://127.0.0.1:<port>/vba/list" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"xlsm_path":"C:/path/to/nothing.xlsm"}'
```
Expected: `409 {"error":"active_tab_changed",...}`（アクティブタブ未設定 or 不一致のため）

認証エラー確認:
```bash
curl -X POST "http://127.0.0.1:<port>/vba/list" \
  -H "Authorization: Bearer wrong" \
  -d '{}'
```
Expected: `401 {"error":"unauthorized"}`

- [ ] **Step 4: コミット**

```bash
git add src-tauri/src/http_bridge.rs
git commit -m "feat(vba): implement /vba/list, /vba/extract, /vba/inject routes with active-tab check"
```

---

## Task 8: settings store に allowLlmVbaImport フィールド追加

**Files:**
- Modify: `src/stores/settings-store.ts`

- [ ] **Step 1: SettingsState に追加**

`src/stores/settings-store.ts` の `interface SettingsState` 内、`mediumSettings: MediumSettings;` の直後に追加:

```typescript
  allowLlmVbaImport: boolean;
```

同 interface の setter セクションに追加（`setMediumSettings` の直後）:

```typescript
  setAllowLlmVbaImport: (enabled: boolean) => void;
```

- [ ] **Step 2: 初期値を追加**

`useSettingsStore` の初期値オブジェクト内、`mediumSettings: DEFAULT_MEDIUM_SETTINGS,` の直後に追加:

```typescript
      allowLlmVbaImport: false,
```

- [ ] **Step 3: setter を追加**

`setMediumSettings: (settings) => set({ mediumSettings: settings }),` の直後に追加:

```typescript
      setAllowLlmVbaImport: (enabled) => set({ allowLlmVbaImport: enabled }),
```

- [ ] **Step 4: partialize に追加**

`persist` の `partialize` コールバック内、`mediumSettings: state.mediumSettings,` の直後に追加:

```typescript
        allowLlmVbaImport: state.allowLlmVbaImport,
```

- [ ] **Step 5: 型チェック**

Run: `cd C:/Users/mtmar/source/repos/mdium && npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/stores/settings-store.ts
git commit -m "feat(vba): add allowLlmVbaImport setting (default off)"
```

---

## Task 9: i18n キー追加

**Files:**
- Modify: `src/shared/i18n/locales/ja/editor.json`
- Modify: `src/shared/i18n/locales/en/editor.json`

- [ ] **Step 1: 既存の最後のマクロ関連キーを特定**

Run: `grep -n "macroImportSuccess" src/shared/i18n/locales/ja/editor.json`

- [ ] **Step 2: ja/editor.json に追加**

既存の `"macroImportSuccess": ...` の直後（ブロック末の `},` の前）に追加:

```json
  "allowLlmVbaImport": "LLM 自動取り込みを許可",
  "allowLlmVbaImportHint": "opencode チャットから VBA マクロを自律編集できるようにします",
  "macroModuleSetChanged": "モジュール構成が変更されています: 追加 {{new}}, 削除 {{missing}}。Excel の VBE で手動追加/削除後、再エクスポートしてください。",
```

- [ ] **Step 3: en/editor.json に追加**

同位置に追加:

```json
  "allowLlmVbaImport": "Allow LLM to auto-import",
  "allowLlmVbaImportHint": "Lets the opencode chat autonomously edit VBA macros",
  "macroModuleSetChanged": "Module set changed: added {{new}}, removed {{missing}}. Add/remove modules in Excel's VBE first, then re-export.",
```

- [ ] **Step 4: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/shared/i18n/locales/ja/editor.json src/shared/i18n/locales/en/editor.json
git commit -m "i18n(vba): add keys for LLM import toggle and module_set_changed error"
```

---

## Task 10: PreviewPanel にトグル UI を追加 + アクティブタブ通知

`.xlsm`/`.xlam` がアクティブな時だけ表示するトグルと、アクティブタブが xlsm に切り替わった時に Rust 側 state を更新する useEffect を追加。さらに、import 成功時（ボタン/MCP 共通）のプレビュー再読込を共通化。

**Files:**
- Modify: `src/features/preview/components/PreviewPanel.tsx`

- [ ] **Step 1: トグル用の import と state**

`src/features/preview/components/PreviewPanel.tsx` の import 文に `useSettingsStore` を追加（既にあれば不要）:

```typescript
import { useSettingsStore } from "@/stores/settings-store";
```

- [ ] **Step 2: トグル state を取得**

PreviewPanel 関数内、既存の `const [macroExporting, setMacroExporting] = useState(false);` の近くに追加:

```typescript
  const allowLlmVbaImport = useSettingsStore((s) => s.allowLlmVbaImport);
  const setAllowLlmVbaImport = useSettingsStore((s) => s.setAllowLlmVbaImport);
```

- [ ] **Step 3: アクティブ xlsm を Rust に通知する useEffect を追加**

`isMacroEnabled` 変数定義の近く（例: `isXlsx` の後）に:

```typescript
  useEffect(() => {
    const filePath = activeTab?.filePath ?? null;
    const isMacroFile =
      filePath !== null &&
      (filePath.toLowerCase().endsWith(".xlsm") ||
        filePath.toLowerCase().endsWith(".xlam"));
    invoke("set_active_xlsm_path", {
      path: isMacroFile ? filePath : null,
    }).catch(() => {});
  }, [activeTab?.filePath]);
```

- [ ] **Step 4: トグル UI を convert-bar 内に追加**

`PreviewPanel.tsx` の既存のマクロボタン群（1131 行目付近の `handleExportMacros` ボタンと `handleImportMacros` ボタン）の後に追加。具体的には `handleImportMacros` のボタンの直後（`macroImporting ? t("importingMacros") : t("importMacros")}` を含む `</button>` の次）に:

```tsx
            <label className="preview-panel__llm-toggle">
              <input
                type="checkbox"
                checked={allowLlmVbaImport}
                onChange={(e) => setAllowLlmVbaImport(e.target.checked)}
              />
              <span title={t("allowLlmVbaImportHint") ?? ""}>
                {t("allowLlmVbaImport")}
              </span>
            </label>
```

- [ ] **Step 5: module_set_changed エラーを handleImportMacros で捕捉**

既存の `handleImportMacros` 内の catch 節（`catch (e) {`）を以下に修正:

```typescript
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Try to parse structured error from Rust
      try {
        const parsed = JSON.parse(msg);
        if (parsed?.error === "module_set_changed") {
          const newList = (parsed.newInFiles ?? []).join(", ") || "-";
          const missingList = (parsed.missingInFiles ?? []).join(", ") || "-";
          setMacroError(
            t("macroModuleSetChanged", { new: newList, missing: missingList })
          );
          return;
        }
      } catch {
        // not JSON; fall through
      }
      setMacroError(msg);
    } finally {
      setMacroImporting(false);
    }
```

（既存の finally ブロックを重複しないよう、元の `finally { setMacroImporting(false); }` は削除してこの置換で一本化）

- [ ] **Step 6: CSS 追加**

`src/features/preview/components/PreviewPanel.css`（存在する想定。なければ作成せずスキップ）の末尾に:

```css
.preview-panel__llm-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 12px;
  font-size: 0.85em;
  user-select: none;
  cursor: pointer;
}

.preview-panel__llm-toggle input {
  cursor: pointer;
}
```

- [ ] **Step 7: ビルド確認**

Run: `npm run build`
Expected: ビルド成功

- [ ] **Step 8: 手動確認**

Run: `npm run tauri dev`

1. `.xlsm` を開く → プレビューパネルに「LLM 自動取り込みを許可」トグルが見えること
2. `.xlsx` を開く → トグルは出ない（`isMacroEnabled` 判定で非表示）
3. トグルを ON → アプリ再起動 → 状態が保持されている（persist 動作確認）

- [ ] **Step 9: コミット**

```bash
git add src/features/preview/components/PreviewPanel.tsx src/features/preview/components/PreviewPanel.css
git commit -m "feat(vba): add LLM import toggle and active xlsm sync in preview panel"
```

---

## Task 11: Node.js MCP サーバー (mdium-vba) の作成

**Files:**
- Create: `resources/mcp-servers/mdium-vba/package.json`
- Create: `resources/mcp-servers/mdium-vba/tsconfig.json`
- Create: `resources/mcp-servers/mdium-vba/.gitignore`
- Create: `resources/mcp-servers/mdium-vba/src/http-client.ts`
- Create: `resources/mcp-servers/mdium-vba/src/index.ts`

- [ ] **Step 1: package.json**

`resources/mcp-servers/mdium-vba/package.json`:

```json
{
  "name": "mdium-mcp-vba",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: tsconfig.json**

`resources/mcp-servers/mdium-vba/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: .gitignore**

`resources/mcp-servers/mdium-vba/.gitignore`:

```
node_modules/
dist/
```

- [ ] **Step 4: http-client.ts**

`resources/mcp-servers/mdium-vba/src/http-client.ts`:

```typescript
const port = process.env.MDIUM_VBA_PORT;
const token = process.env.MDIUM_VBA_TOKEN;

if (!port || !token) {
  console.error(
    "mdium-vba MCP server: missing required env vars MDIUM_VBA_PORT / MDIUM_VBA_TOKEN"
  );
  process.exit(1);
}

const base = `http://127.0.0.1:${port}`;
const authHeader = `Bearer ${token}`;

/**
 * Get the currently active .xlsm/.xlam tab in MDium.
 * Returns null if no such tab is active.
 */
export async function getActiveXlsm(): Promise<string | null> {
  const response = await fetch(`${base}/active-xlsm`, {
    headers: { Authorization: authHeader },
  });
  if (!response.ok) {
    throw new Error(`Failed to resolve active xlsm (HTTP ${response.status})`);
  }
  const json = (await response.json()) as { path: string | null };
  return json.path;
}

interface RequestBody {
  xlsm_path: string;
  macros_dir?: string;
}

export async function callBridge(
  route: "/vba/list" | "/vba/extract" | "/vba/inject",
  body: RequestBody
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(base + route, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = { error: "invalid_response" };
  }
  return { status: response.status, json };
}
```

- [ ] **Step 5: index.ts**

`resources/mcp-servers/mdium-vba/src/index.ts`:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as path from "path";
import { callBridge, getActiveXlsm } from "./http-client.js";

function deriveMacrosDir(xlsmPath: string): string {
  const parsed = path.parse(xlsmPath);
  return path.join(parsed.dir, `${parsed.name}_macros`);
}

function toolText(obj: unknown): {
  content: { type: "text"; text: string }[];
} {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2),
      },
    ],
  };
}

const server = new McpServer({
  name: "mdium-vba",
  version: "1.0.0",
});

async function resolveAndCall(
  route: "/vba/list" | "/vba/extract" | "/vba/inject",
  includeMacrosDir: boolean
) {
  let xlsm: string | null;
  try {
    xlsm = await getActiveXlsm();
  } catch (e) {
    return toolText({
      error: "bridge_unavailable",
      message: e instanceof Error ? e.message : String(e),
    });
  }
  if (!xlsm) {
    return toolText({
      error: "no_active_xlsm",
      message: "No active .xlsm/.xlam tab in MDium. Open one first.",
    });
  }
  const body: { xlsm_path: string; macros_dir?: string } = { xlsm_path: xlsm };
  if (includeMacrosDir) body.macros_dir = deriveMacrosDir(xlsm);

  let result = await callBridge(route, body);

  // Retry once on active_tab_changed race condition
  if (
    result.status === 409 &&
    typeof result.json === "object" &&
    result.json !== null &&
    (result.json as { error?: string }).error === "active_tab_changed"
  ) {
    const fresh = await getActiveXlsm();
    if (fresh) {
      const retryBody: { xlsm_path: string; macros_dir?: string } = {
        xlsm_path: fresh,
      };
      if (includeMacrosDir) retryBody.macros_dir = deriveMacrosDir(fresh);
      result = await callBridge(route, retryBody);
    }
  }

  return toolText(result.json);
}

server.tool(
  "list_vba_modules",
  "List VBA modules in the currently active .xlsm/.xlam tab in MDium. Returns macros directory path, whether it has been extracted, and module list.",
  {},
  async () => resolveAndCall("/vba/list", false)
);

server.tool(
  "extract_vba_modules",
  "Extract VBA modules from the currently active .xlsm/.xlam tab into {stem}_macros/. Overwrites existing files. Returns the macros directory and module list.",
  {},
  async () => resolveAndCall("/vba/extract", false)
);

server.tool(
  "import_vba_macros",
  "Import modified .bas/.cls files from {stem}_macros/ back into the currently active .xlsm/.xlam tab. Refuses if the module set differs (no adding or removing modules is supported). Returns updatedModules and backupPath on success.",
  {},
  async () => resolveAndCall("/vba/inject", true)
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 6: 依存インストール + ビルド**

Run:
```bash
cd resources/mcp-servers/mdium-vba
npm install
npm run build
```
Expected: `dist/index.js`, `dist/http-client.js` が生成される

- [ ] **Step 7: 単体動作確認（env var 不足時のエラー）**

Run:
```bash
cd resources/mcp-servers/mdium-vba
node dist/index.js
```
Expected: 標準エラー出力に `missing required env vars` が出て exit code 1 で終了

- [ ] **Step 8: コミット**

```bash
git add resources/mcp-servers/mdium-vba/package.json \
        resources/mcp-servers/mdium-vba/tsconfig.json \
        resources/mcp-servers/mdium-vba/.gitignore \
        resources/mcp-servers/mdium-vba/src/http-client.ts \
        resources/mcp-servers/mdium-vba/src/index.ts \
        resources/mcp-servers/mdium-vba/package-lock.json
git commit -m "feat(vba): add mdium-vba MCP server (Node) with list/extract/import tools"
```

---

## Task 12: builtin-mcp-servers.ts に mdium-vba を登録（条件付き）

既存の nano-banana-2 と同じ `BUILTIN_MCP_SERVERS` に登録。ただし env var に xlsm パスとトークンを動的に埋め込む必要があるため、静的定義に加えて「チャット起動時に解決する関数」も用意する。

**Files:**
- Modify: `src/features/opencode-config/lib/builtin-mcp-servers.ts`

- [ ] **Step 1: mdium-vba の静的定義を追加**

`src/features/opencode-config/lib/builtin-mcp-servers.ts` の既存 `BUILTIN_MCP_SERVERS` オブジェクト内、`"nano-banana-2"` エントリの後に追加:

```typescript
  "mdium-vba": {
    serverName: "mdium-vba",
    type: "local",
    command: ["node", "<mcp_servers_path>\\mdium-vba\\dist\\index.js"],
    enabled: false,
    environment: {
      MDIUM_VBA_PORT: "<placeholder>",
      MDIUM_VBA_TOKEN: "<placeholder>",
    },
  },
```

- [ ] **Step 2: 解決ヘルパ関数を追加**

`src/features/opencode-config/lib/builtin-mcp-servers.ts` の末尾に追加:

```typescript
import { invoke } from "@tauri-apps/api/core";

/**
 * Resolve mdium-vba MCP server with concrete env vars.
 * Port/token are fetched from the HTTP bridge; xlsm is determined at tool-call
 * time by the MCP server itself via GET /active-xlsm (not baked in).
 * Returns null if the HTTP bridge is not yet started.
 */
export async function resolveMdiumVbaMcpServer(
  mcpServersPath: string
): Promise<{
  serverName: string;
  type: "local";
  command: string[];
  enabled: boolean;
  environment: Record<string, string>;
} | null> {
  const bridge = await invoke<{ port: number; token: string } | null>(
    "get_http_bridge_info"
  ).catch(() => null);
  if (!bridge) return null;

  const template = BUILTIN_MCP_SERVERS["mdium-vba"];
  return {
    serverName: template.serverName,
    type: "local",
    command: resolveBuiltinCommand(template.command, mcpServersPath),
    enabled: true,
    environment: {
      MDIUM_VBA_PORT: String(bridge.port),
      MDIUM_VBA_TOKEN: bridge.token,
    },
  };
}
```

- [ ] **Step 3: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 4: コミット**

```bash
git add src/features/opencode-config/lib/builtin-mcp-servers.ts
git commit -m "feat(vba): register mdium-vba MCP server template and dynamic resolver"
```

---

## Task 13: 送信メッセージラップ (L1) と opencode MCP 設定への登録

MDium の `BUILTIN_MCP_SERVERS` は `useOpencodeChat.ts` で直接 opencode に渡しているわけではなく、`builtin-registry.ts` の `getMissingBuiltinMcp` を経由して opencode 自身の永続 config（`~/.config/opencode/...` 配下）に書かれる。そのため **Phase 1 は「トグル ON で opencode config に `mdium-vba` エントリを書き込む／OFF で削除」という形で実装**する。MDium 起動のたびに port/token が変わるので、起動時とトグル変更時に必ず書き換える。

**Files:**
- Modify: `src/features/opencode-config/hooks/useOpencodeChat.ts`
- 事前調査が必要: `src/features/opencode-config/components/sections/McpServersSection.tsx` と `src/features/opencode-config/lib/builtin-registry.ts` にある既存の「builtin MCP 追加」UI フローのコードを読み、そこから実行されている書き込み API（例えば `claude_config::write_json_file` 系の Tauri コマンド、あるいは opencode SDK の config update API）を特定する。

- [ ] **Step 1: 事前調査**

Run:
```
grep -rn "BUILTIN_MCP\|mcp.*write\|updateMcp\|addMcp" src/features/opencode-config
grep -rn "getMissingBuiltinMcp" src
```
opencode の MCP サーバー設定を永続化している場所を特定する。代表的には `McpServersSection.tsx` の「追加」ボタンが呼ぶ handler を辿ると、最終的な書き込み API が見つかる。発見した API を `writeOpencodeMcpEntry(name, entry)` / `removeOpencodeMcpEntry(name)` のように抽象化して使える想定。見つからなければ追加実装が必要。

- [ ] **Step 2: L1 メッセージラップヘルパを追加**

`src/features/opencode-config/hooks/useOpencodeChat.ts` の import 文に追加（既にあれば不要）:

```typescript
import { useSettingsStore } from "@/stores/settings-store";
```

ファイル上部のトップレベル関数定義領域（フックの中ではなく、`export function useOpencodeChat` の外）にヘルパを追加:

```typescript
async function wrapWithMdiumContext(userMessage: string): Promise<string> {
  const active = await invoke<string | null>("get_active_xlsm_path").catch(() => null);
  if (!active) return userMessage;
  return `<mdium_context>\nactive_file="${active.replace(/"/g, '\\"')}"\n</mdium_context>\n\n${userMessage}`;
}
```

- [ ] **Step 3: doSendMessage にラップを適用**

`src/features/opencode-config/hooks/useOpencodeChat.ts` 内の `doSendMessage`（モジュールトップレベルで定義されている送信処理）の先頭で、引数 `text` を wrap 済みに差し替える。既存コードの先頭に 1 行追加:

```typescript
  text = await wrapWithMdiumContext(text);
```

`text: string` が readonly 扱いでエラーが出るなら、`let wrappedText = await wrapWithMdiumContext(text);` を使い、以降の `text` 参照を `wrappedText` に置換する。

- [ ] **Step 4: opencode MCP 設定同期関数を追加**

`src/features/opencode-config/hooks/useOpencodeChat.ts` に同期関数を追加（トップレベル関数として、Step 1 で特定した書き込み API を使用）:

```typescript
import { resolveMdiumVbaMcpServer } from "../lib/builtin-mcp-servers";

/**
 * Ensure the mdium-vba MCP server is present in opencode config if allowed,
 * and absent otherwise. Always called at app startup (port/token change each run).
 */
export async function syncMdiumVbaMcpConfig(): Promise<void> {
  const enabled = useSettingsStore.getState().allowLlmVbaImport;
  const mcpServersPath = await invoke<string>("resolve_mcp_servers_path").catch(
    () => null
  );
  if (!mcpServersPath) return;

  if (enabled) {
    const entry = await resolveMdiumVbaMcpServer(mcpServersPath);
    if (!entry) return;
    // Call the opencode MCP config update API identified in Step 1.
    // e.g.:
    //   await writeOpencodeMcpEntry("mdium-vba", {
    //     type: entry.type,
    //     command: entry.command,
    //     enabled: entry.enabled,
    //     environment: entry.environment,
    //   });
  } else {
    // e.g.:
    //   await removeOpencodeMcpEntry("mdium-vba");
  }
}
```

- [ ] **Step 5: 起動時とトグル変更時に sync を呼ぶ**

`syncMdiumVbaMcpConfig` を以下のタイミングで呼ぶ:

(a) **アプリ起動時**（`useOpencodeChat` の `doConnect` が最初に成功した直後、または `src/app/App.tsx` の初期化フック内）:
```typescript
syncMdiumVbaMcpConfig().catch((e) => console.warn("mdium-vba sync failed:", e));
```

(b) **トグル変更時** — `PreviewPanel.tsx` の `setAllowLlmVbaImport` ハンドラ内で、設定更新の直後に呼ぶ（Task 10 で実装したハンドラを拡張）:
```typescript
onChange={(e) => {
  setAllowLlmVbaImport(e.target.checked);
  syncMdiumVbaMcpConfig().catch(() => {});
}}
```

(c) PreviewPanel から呼ぶには `syncMdiumVbaMcpConfig` をエクスポートして import する必要がある。

- [ ] **Step 6: 型チェックとビルド**

Run: `npx tsc --noEmit && npm run build`
Expected: エラーなし

- [ ] **Step 7: コミット**

```bash
git add src/features/opencode-config/hooks/useOpencodeChat.ts \
        src/features/preview/components/PreviewPanel.tsx
git commit -m "feat(vba): wrap messages with active tab context and sync opencode MCP config"
```

---

## Task 14: vba-coding-conventions スキルに MDium フロー節を追加

既存のビルトインスキル `vba-coding-conventions` に、トグル ON 時のみ表示される「MDium マクロ編集フロー」セクションを追加。

**Files:**
- Modify: `src/features/opencode-config/lib/builtin-skills.ts`

- [ ] **Step 1: 既存スキルの末尾を特定**

Run: `grep -n "vba-coding-conventions" src/features/opencode-config/lib/builtin-skills.ts`

既存コンテンツの末尾（現状 `content: \`...\`` の閉じバッククォート）を確認。

- [ ] **Step 2: MDium フロー節を追加する設計**

`BUILTIN_SKILLS` の `vba-coding-conventions` は固定文字列。条件付き混入するには以下いずれか:

(A) 別スキルとして `vba-coding-conventions-mdium-flow` を追加し、呼び出し側（opencode 起動時）でトグル ON 時のみ両方を有効化する
(B) 既存の `content` を 2 部構成にし、「ベース + MDium フロー節」を返すヘルパ関数を追加する

Phase 1 は (A) を採用（ロジックが単純、既存スキルを汚染しない）。

- [ ] **Step 3: 新スキル `vba-mdium-flow` を追加**

`src/features/opencode-config/lib/builtin-skills.ts` の `BUILTIN_SKILLS` 内、`"vba-coding-conventions"` エントリの後に追加:

```typescript
  "vba-mdium-flow": {
    name: "vba-mdium-flow",
    description:
      "Use when the MDium mdium-vba MCP server is available — guides the LLM through the extract → edit → import workflow and warns about module-set constraints.",
    content: `# MDium マクロ編集フロー

このセッションでは MDium の \`mdium-vba\` MCP サーバーが利用可能です。

## 標準フロー

1. \`list_vba_modules\` で既存の \`_macros/\` 状態を確認
2. \`_macros/\` が未エクスポートなら \`extract_vba_modules\` を呼ぶ
3. Read/Edit ツールで \`.bas\` / \`.cls\` を編集
4. **編集が完了したら必ず \`import_vba_macros\` を呼ぶ**
5. 応答の \`updatedModules\` をユーザーに報告

## 重要な制約

- このツールは **ツール呼び出しの瞬間のアクティブタブ** に対して動作します
- 毎ターン、ユーザーメッセージ先頭の \`<mdium_context>\` タグで現在のアクティブファイルが分かります
- ツール応答の \`activeFile\` と \`<mdium_context>\` の \`active_file\` が一致することを確認してください
- 会話中にユーザーがタブを切り替えたら \`active_file\` が変わります。ユーザーの意図を必ず確認してください:
  「アクティブタブが {old} から {new} に変わりましたが、このまま続けますか？」
- \`error: "active_tab_changed"\` が返った場合は race condition です。1 回だけ retry してください

## モジュール構成を変えてはいけない

**\`.bas\` / \`.cls\` ファイルの新規作成・削除・リネームはしないでください。** MDium の取り込みは**既存モジュールの中身差し替えのみ**サポートします。

- 新規モジュールを作りたい → ユーザーに Excel の VBE で手動追加してもらい、再度 \`extract_vba_modules\` を呼んで取得
- モジュールを削除したい → ユーザーに Excel の VBE で手動削除してもらう
- リネームしたい → 同様にユーザーに VBE で行ってもらう

\`import_vba_macros\` が \`error: "module_set_changed"\` を返した場合、\`newInFiles\` と \`missingInFiles\` の内容を見て、どちらの変更を戻すべきかユーザーに確認してください。
`,
  },
```

- [ ] **Step 4: スキル有効化条件の検討**

このスキルは「トグル ON かつアクティブ xlsm がある時」だけ有効化すべき。スキルの有効化ロジックは `useOpencodeChat.ts` 側で処理される（BUILTIN_SKILLS を参照してシステムプロンプトに混入している場所）。`grep -n "BUILTIN_SKILLS" src/features/opencode-config/hooks/useOpencodeChat.ts` で該当箇所を探し、`mdium-vba` の有効化条件と同じロジックで `vba-mdium-flow` スキルを条件付き有効化する。

実装箇所の具体案（該当 useOpencodeChat の該当処理に合わせて調整）:

```typescript
  // Conditionally enable vba-mdium-flow skill alongside mdium-vba MCP server
  const shouldEnableMdiumVbaFlow =
    useSettingsStore.getState().allowLlmVbaImport &&
    (await getActiveXlsmPath()) !== null;

  if (shouldEnableMdiumVbaFlow) {
    // add "vba-mdium-flow" to the active skills list
  } else {
    // ensure "vba-mdium-flow" is not in the active skills list
  }
```

実装時は既存スキル有効化フロー（例: `enabledSkills` 配列への追加など）に倣って書く。

- [ ] **Step 5: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/features/opencode-config/lib/builtin-skills.ts src/features/opencode-config/hooks/useOpencodeChat.ts
git commit -m "feat(vba): add vba-mdium-flow skill conditionally alongside mdium-vba MCP"
```

---

## Task 15: 手動 E2E テスト

**Files:** なし（テスト手順のみ）

- [ ] **Step 1: ビルドと起動**

Run:
```bash
cd resources/mcp-servers/mdium-vba && npm run build
cd ../../.. && npm run tauri dev
```

- [ ] **Step 2: トグル OFF 時の挙動確認**

1. `.xlsm` ファイルを開く
2. トグルはデフォルト OFF
3. opencode チャットを起動（既存の preview command 経由）
4. LLM に「マクロの一覧を教えて」と依頼
5. LLM が `list_vba_modules` ツールを持っていないこと（MCP サーバー未混入）を確認

- [ ] **Step 3: トグル ON + 通常フロー**

1. `.xlsm` ファイルを開く
2. 「LLM 自動取り込みを許可」トグルを ON
3. opencode チャットを起動（新規）
4. LLM に「Module1 の Hello() に引数 name を追加して」と依頼
5. LLM が以下を順に実行することを確認:
   - `list_vba_modules` or `extract_vba_modules` を呼ぶ
   - `.bas` ファイルを Read/Edit で編集
   - `import_vba_macros` を呼ぶ
6. プレビューが自動再読込され、トーストで成功通知
7. `.xlsm.bak` が作成されている
8. Excel で `.xlsm` を開き、変更が反映されていることを確認

- [ ] **Step 4: strict モジュール構成検出**

1. トグル ON の状態で、LLM に「新規の Module2.bas を作って中に Sub Test() を書いて import も実行して」と依頼
2. LLM が `import_vba_macros` を呼んだ時、`module_set_changed` エラーが返ること
3. LLM がユーザーに「モジュールの追加は VBE で手動で」と説明すること
4. `.xlsm` は変更されていない、`.xlsm.bak` も作成されていないこと

- [ ] **Step 5: L2 アクティブタブ不一致の fail-safe**

1. `.xlsm` A を開いてチャット開始、トグル ON
2. 同じチャットで `list_vba_modules` を LLM に呼ばせる（正常動作）
3. 別タブで `.xlsm` B に切り替え
4. 同じチャットに「このマクロを直して」と送る
5. LLM がメッセージ先頭の `<mdium_context>active_file="B.xlsm"</mdium_context>` を読み取ること
6. LLM が「アクティブタブが A.xlsm から B.xlsm に変わりましたが、このまま続けますか？」と意図確認すること
7. ユーザーが「A.xlsm のままで」と答えれば、LLM は B.xlsm には手を出さず、A.xlsm タブに戻すよう促すこと

- [ ] **Step 6: L1 アクティブファイル注入確認**

1. チャット送信後の opencode の会話ログ（デバッグログ or 開発者コンソール）で、ユーザーメッセージに `<mdium_context>active_file="..."</mdium_context>` が先頭付加されていることを確認

- [ ] **Step 7: `.xlsx` でトグルが出ないこと**

1. `.xlsx`（マクロ無し）を開く
2. トグル UI が非表示であること

- [ ] **Step 8: UI ボタン経由 inject の strict チェック**

1. `_macros/` に手動で新規 `.bas` を追加
2. UI の「マクロのインポート」ボタンを押す
3. `macroModuleSetChanged` i18n メッセージがエラーとして表示される
4. `.xlsm` は変更されていない

- [ ] **Step 9: クリーンアップコミット（もしあれば）**

手動テストで発見した軽微な問題があれば修正コミット。

```bash
git add -A
git commit -m "fix(vba): address issues found during E2E testing"
```

---

## Self-Review Checklist

実装完了後に確認する項目:

### Spec coverage
- [ ] Q1〜Q8 で決定したすべての要素が実装されているか
- [ ] strict モード（モジュール構成変更拒否）が inject の UI 経由・MCP 経由の両方で動くか
- [ ] アクティブタブ不一致で HTTP bridge が 409 を返すか
- [ ] トグル OFF で MCP サーバーが混入しないか
- [ ] L1 メッセージラップが全ユーザー送信に適用されているか

### Ambiguity
- [ ] `backup_path` はすべて `{xlsm_path}.bak`（`Book1.xlsm.bak`）形式で生成されている
- [ ] Windows でパス比較が大文字小文字無視になっている（`check_active_tab`）
- [ ] トークン長 32 文字で十分にランダム（`generate_token`）

### Type consistency
- [ ] Rust 側: `ListResult`, `ExtractResult`, `InjectResult` のフィールド名が MCP サーバーの期待値と整合
- [ ] MCP サーバー戻り値の JSON が `activeFile`, `macrosDir`, `exists`, `modules`, `backupPath`, `updatedModules`, `newInFiles`, `missingInFiles` で統一
- [ ] i18n キーが ja/en 両方で揃っている

実装で型ミスマッチや paths の不整合が出たら即修正する。

---

## Phase 2 (別 spec、今回のスコープ外)

- `run_vba_macro` ツール（Excel COM 自動化）
- 実行結果取得（`Debug.Print` / 指定セル / 戻り値関数）
- 実行前安全ガード、サンドボックスコピー実行
- モジュール追加/削除/リネームのサポート（`dir` ストリーム書き換え、`PROJECTMODULES` 更新）
