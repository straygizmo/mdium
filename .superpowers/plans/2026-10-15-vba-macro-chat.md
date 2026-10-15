# Excel マクロ編集の専用チャット化 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `.xlsm` / `.xlam` を開くと専用のマクロチャットが現れ、利用者が変更内容を書くだけで LLM が展開 → 編集 → 書き戻し(モジュールの追加・削除込み)まで行えるようにする。

**Architecture:** Rust 側は `vbaProject.bin` の `dir` / `PROJECT` / `PROJECTwm` ストリームをレコード単位で読み書きし、パス引数だけを取る `list / pull / push` コマンドと HTTP ブリッジに整理する。opencode 側は `rag_search` と同じ方式で自動インストールされるカスタムツール 3 本とスキル 2 本が LLM を自走させる。フロントは xlsm タブを「シートプレビュー | マクロチャット」に分割し、既存のチャット部品をブックに紐づくセッションで再利用する。

**Tech Stack:** Rust (tauri 2, cfb 0.10, zip 2, encoding_rs, tiny_http), TypeScript/React 18, zustand (persist), vitest + happy-dom, opencode custom tools (`@opencode-ai/plugin`)

**Spec:** `.superpowers/specs/2026-10-15-vba-macro-chat-design.md`

## Global Constraints

- コード内コメントは英語で書く(CLAUDE.md)
- UI に出る文字列はすべて i18n(`editor` 名前空間、ja / en の両方)。ハードコード禁止(CLAUDE.md)
- マクロフォルダは常に `<名前>_assets/macros/`(仕様 1 章)。他の導出は残さない
- ツールの引数は `xlsm_path` のみ。マクロフォルダを呼び出し側が指定できる経路を作らない(仕様 3.4)
- 書き込み前の検証で失敗した場合はブックも `.bak` も変更しない(仕様 8 章)
- ドキュメントモジュール(ThisWorkbook・シート)とユーザーフォームは追加・削除しない(仕様 4.5)
- 新規モジュールは `MODULEOFFSET = 0`、圧縮ソースのみ(仕様 4.3 / 4.8)
- 利用者が自作・改変したツールやスキル(版マーカー無し、または `SKILL.md.disabled` あり)は上書きしない(仕様 3.1 / 5.1)
- コミットメッセージは `feat(vba): ...` / `test(vba): ...` 形式。末尾に `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
- Rust テストは `src-tauri` で `cargo test vba`、フロントは `npm test -- <path>`、型は `npx tsc --noEmit`

## Review Focus

仕様が暗に要求するが、どのタスクの本筋のテストも触れない入力。各行のテストは所有タスクに追加済み。

1. **UTF-8 BOM 付きの `.bas` / `.cls`**(エディタが付けることがある)→ BOM を落として取り込む。`Attribute VB_Name` が BOM の後ろにあっても認識する(Task 4)
2. **ファイル名の大文字小文字だけが違う**(`module1.bas` と `Module1`)→ 同じモジュールの更新として扱い、追加+削除にしない(Task 5)
3. **拡張子が大文字**(`BOOK.XLSM`)→ マクロ入りブックとして受け付ける(Task 1)
4. **日本語を含むフォルダ・ファイル名** → ツール → ブリッジ → Rust を通して正しく届き、マクロフォルダも同じ階層にできる(Task 5 の往復テストを日本語名の一時フォルダで走らせる)
5. **`vbaProject.bin` の無い `.xlsm`**(マクロを削除済み)をタブで開く → マクロチャットは「マクロがありません」を表示して落ちない(Task 12)

## ファイル構成

| 区分 | ファイル | 責務 |
|---|---|---|
| Rust | `src-tauri/src/commands/vba.rs` | コマンド(`list_vba_modules` / `pull_vba_modules` / `push_vba_modules` / `check_workbook_lock`)、ZIP とコードページの補助、圧縮(既存)、往復テスト |
| Rust | `src-tauri/src/commands/vba_streams.rs`(新規) | `DirStream` / `ProjectStream` / `ProjectWm` の分解・編集・再直列化 |
| Rust | `src-tauri/src/commands/vba_source.rs`(新規) | ソース正規化、モジュール名検証、`extract_vb_name` / `fix_vb_name`(vba.rs から移動) |
| Rust | `src-tauri/src/http_bridge.rs` | `/vba/list` `/vba/pull` `/vba/push`、`vba-pushed` イベント、`get_http_bridge_info` |
| Rust | `src-tauri/src/commands/active_xlsm.rs` | 削除 |
| Rust | `src-tauri/src/lib.rs`、`commands/mod.rs` | 登録の更新 |
| tools | `.opencode/tools/vba_list.ts` / `vba_pull.ts` / `vba_push.ts`(新規) | opencode カスタムツール |
| front | `src/features/opencode-config/lib/builtin-install.ts`(新規) | 版マーカー判定、`buildSkillMd` |
| front | `src/features/opencode-config/lib/builtin-registry.ts` | ツール登録の追加 |
| front | `src/features/opencode-config/lib/builtin-skills.ts` | `vba-mdium-flow` 書き直し、`version` |
| front | `src/features/opencode-config/lib/mdium-context.ts`(新規) | `<mdium_context>` の組み立て(純関数) |
| front | `src/features/opencode-config/hooks/useOpencodeChat.ts` | `ensureBuiltinFiles`、MCP 同期の削除、`doLoadSession` の export |
| front | `src/features/opencode-config/components/OpencodeChat.tsx` | `variant` / `header` / `placeholder` props |
| front | `src/features/opencode-config/components/sections/SkillsSection.tsx` | 共用 `buildSkillMd` を使う |
| front | `src/features/opencode-config/lib/builtin-mcp-servers.ts` | `mdium-vba` の削除 |
| front | `src/stores/macro-chat-store.ts`(新規) | ブック → セッション ID、分割比率、ロック状態 |
| front | `src/features/preview/components/MacroChatPane.tsx` / `.css`(新規) | 専用マクロチャット |
| front | `src/features/preview/components/PreviewPanel.tsx` / `.css` | 分割表示、pull/push ボタン、トグル削除、`vba-pushed` 購読 |
| front | `src/stores/settings-store.ts` | `allowLlmVbaImport` の削除 |
| front | `src/shared/i18n/locales/{ja,en}/editor.json` | キーの追加・削除 |
| 削除 | `resources/mcp-servers/mdium-vba/` | MCP サーバー |
| docs | `docs/builtin-skills.ja.md`、`README.md`、`README.ja.md` | 記述更新 |

仕様 6.5 の「`OpencodeChatView` への切り出し」は、`OpencodeChat` に `variant` / `header` / `placeholder` props を足す形で実現する(750 行の部品を物理分割するより差分が小さく、共用という目的は同じ)。

---

## Part A: Rust

### Task 1: マクロフォルダの統一とロック判定

**Files:**
- Modify: `src-tauri/src/commands/vba.rs`(`list_vba_modules` 1088-1178 行、`extract_vba_modules` 620-749 行、構造体 8-37 行)
- Test: 同ファイルの `mod tests`

**Interfaces:**
- Produces: `pub fn macros_dir_for(xlsm_path: &Path) -> Result<PathBuf, String>`、`pub fn is_macro_workbook(path: &Path) -> bool`、`pub fn workbook_lock(path: &Path) -> WorkbookLock`、`pub fn vba_error(code: &str, message: impl Into<String>) -> String`、`#[tauri::command] check_workbook_lock(xlsm_path: String) -> Result<WorkbookLock, String>`、`#[tauri::command] pull_vba_modules(xlsm_path: String) -> Result<PullResult, String>`、`list_vba_modules` の戻り値 `ListResult { xlsm_path, macros_dir, extracted, locked, modules }`
- `VbaModule.path` は `Option<String>`(無いときは `None` → JSON `null`)

- [ ] **Step 1: 失敗するテストを書く**

`mod tests` の末尾(既存の `test_inject_error_*` 2 本は Task 5 で削除するので、その前に追加)に:

```rust
    // --- Task 1: paths and lock ---

    #[test]
    fn macros_dir_is_assets_macros_next_to_workbook() {
        let dir = macros_dir_for(Path::new("C:/work/Book1.xlsm")).unwrap();
        assert_eq!(dir, Path::new("C:/work").join("Book1_assets").join("macros"));
    }

    #[test]
    fn macro_workbook_extension_is_case_insensitive() {
        assert!(is_macro_workbook(Path::new("C:/w/BOOK.XLSM")));
        assert!(is_macro_workbook(Path::new("C:/w/addin.xlam")));
        assert!(!is_macro_workbook(Path::new("C:/w/plain.xlsx")));
    }

    #[test]
    fn workbook_lock_is_false_for_writable_file() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("Book1.xlsm");
        std::fs::write(&p, b"x").unwrap();
        let lock = workbook_lock(&p);
        assert!(!lock.locked);
        assert_eq!(lock.reason, None);
    }

    #[cfg(windows)]
    #[test]
    fn workbook_lock_reports_write_denied_when_another_handle_denies_sharing() {
        use std::os::windows::fs::OpenOptionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("Book1.xlsm");
        std::fs::write(&p, b"x").unwrap();
        // Excel keeps the workbook open without write sharing; emulate that.
        let _holder = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&p)
            .unwrap();
        let lock = workbook_lock(&p);
        assert!(lock.locked);
        assert_eq!(lock.reason.as_deref(), Some("write_denied"));
    }

    #[cfg(windows)]
    #[test]
    fn workbook_lock_names_owner_file_when_present() {
        use std::os::windows::fs::OpenOptionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("Book1.xlsm");
        std::fs::write(&p, b"x").unwrap();
        std::fs::write(tmp.path().join("~$Book1.xlsm"), b"owner").unwrap();
        let _holder = std::fs::OpenOptions::new().read(true).share_mode(0).open(&p).unwrap();
        let lock = workbook_lock(&p);
        assert!(lock.locked);
        assert_eq!(lock.reason.as_deref(), Some("owner_file"));
    }

    #[test]
    fn vba_error_is_json_with_code_and_message() {
        let e = vba_error("invalid_workbook", "not an xlsm");
        let v: serde_json::Value = serde_json::from_str(&e).unwrap();
        assert_eq!(v["error"], "invalid_workbook");
        assert_eq!(v["message"], "not an xlsm");
    }
```

- [ ] **Step 2: 失敗を確認**

Run: `cd src-tauri && cargo test vba::tests::macros_dir_is_assets -- --nocapture`
Expected: コンパイルエラー(`macros_dir_for` 未定義)

- [ ] **Step 3: 実装**

`vba.rs` の `use` に `use std::path::PathBuf;` を追加し、構造体群を次に置き換える(既存 `ExtractResult` / `InjectResult` は削除、`VbaModule.path` を `Option<String>` に):

```rust
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VbaModule {
    pub name: String,
    pub module_type: String, // "standard" | "class" | "document"
    /// Path of the extracted file; None when the macros dir has no file for it.
    pub path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    pub xlsm_path: String,
    pub macros_dir: String,
    pub modules: Vec<VbaModule>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub xlsm_path: String,
    pub macros_dir: String,
    pub extracted: bool,
    pub locked: bool,
    pub modules: Vec<VbaModule>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookLock {
    pub locked: bool,
    /// "owner_file" | "write_denied" when locked.
    pub reason: Option<String>,
}

/// Structured error string shared by commands, bridge and UI:
/// `{"error": <code>, "message": <text>}`.
pub fn vba_error(code: &str, message: impl Into<String>) -> String {
    serde_json::json!({ "error": code, "message": message.into() }).to_string()
}

/// `<stem>_assets/macros/` next to the workbook. The single source of truth
/// for where extracted modules live.
pub fn macros_dir_for(xlsm_path: &Path) -> Result<PathBuf, String> {
    let stem = xlsm_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| vba_error("invalid_workbook", "Invalid file name"))?;
    let parent = xlsm_path
        .parent()
        .ok_or_else(|| vba_error("invalid_workbook", "Cannot determine parent directory"))?;
    Ok(parent.join(format!("{}_assets", stem)).join("macros"))
}

pub fn is_macro_workbook(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("xlsm") | Some("xlam")
    )
}

/// Validate path + extension; returns the structured error used by all commands.
fn require_macro_workbook(xlsm_path: &str) -> Result<&Path, String> {
    let p = Path::new(xlsm_path);
    if !p.exists() {
        return Err(vba_error("invalid_workbook", format!("File not found: {}", xlsm_path)));
    }
    if !is_macro_workbook(p) {
        return Err(vba_error("invalid_workbook", "Only .xlsm and .xlam workbooks are supported"));
    }
    Ok(p)
}

/// Excel holds an open workbook without write sharing, so a write-mode open
/// fails while it is open. The `~$<name>` owner file only refines the reason
/// (a stale owner file after a crash must not lock the workbook forever).
pub fn workbook_lock(path: &Path) -> WorkbookLock {
    let write_denied = match fs::OpenOptions::new().write(true).open(path) {
        Ok(_) => false,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => true,
    };
    if !write_denied {
        return WorkbookLock { locked: false, reason: None };
    }
    let owner_file_exists = match (path.parent(), path.file_name().and_then(|n| n.to_str())) {
        (Some(parent), Some(name)) => parent.join(format!("~${}", name)).exists(),
        _ => false,
    };
    WorkbookLock {
        locked: true,
        reason: Some(if owner_file_exists { "owner_file" } else { "write_denied" }.to_string()),
    }
}

#[tauri::command]
pub fn check_workbook_lock(xlsm_path: String) -> Result<WorkbookLock, String> {
    Ok(workbook_lock(Path::new(&xlsm_path)))
}
```

`extract_vba_modules` を `pull_vba_modules` に改名し、冒頭と出力を差し替える:

```rust
#[tauri::command]
pub fn pull_vba_modules(xlsm_path: String) -> Result<PullResult, String> {
    let file_path = require_macro_workbook(&xlsm_path)?;
    let vba_bin = read_vba_project_bin(&xlsm_path)
        .map_err(|e| vba_error("no_vba_project", e))?;
    // ... (existing OLE2 / dir parsing unchanged; map parse errors with vba_error("pull_failed", e)) ...
    let macros_dir = macros_dir_for(file_path)?;
    // ... (existing write loop unchanged, but `path: Some(module_path.to_string_lossy().into_owned())`) ...
    Ok(PullResult {
        xlsm_path: xlsm_path.clone(),
        macros_dir: macros_dir.to_string_lossy().into_owned(),
        modules,
    })
}
```

`list_vba_modules` の `macros_dir` 導出(`{stem}_macros`)を `macros_dir_for(path)?` に置き換え、戻り値を:

```rust
    Ok(ListResult {
        xlsm_path: xlsm_path.clone(),
        macros_dir: macros_dir.to_string_lossy().into_owned(),
        extracted: macros_dir.is_dir(),
        locked: workbook_lock(path).locked,
        modules,
    })
```

(`path_str` は `if file_path.exists() { Some(...) } else { None }` に。)

`lib.rs` の登録を `commands::vba::pull_vba_modules`、`commands::vba::check_workbook_lock` に更新(`extract_vba_modules` の行を置換、`inject_vba_modules` は Task 5 まで残す)。

- [ ] **Step 4: テスト実行**

Run: `cd src-tauri && cargo test vba`
Expected: 新テストを含め PASS(`test_inject_error_*` はフィクスチャ無しで skip ログを出して PASS)

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/commands/vba.rs src-tauri/src/lib.rs
git commit -m "feat(vba): unify macros dir, add workbook lock check and pull command"
```

### Task 2: `PROJECT` / `PROJECTwm` ストリームの分解と編集

**Files:**
- Create: `src-tauri/src/commands/vba_streams.rs`
- Modify: `src-tauri/src/commands/mod.rs`(`pub mod vba_streams;` を追加)
- Test: 同ファイルの `mod tests`

**Interfaces:**
- Consumes: `crate::commands::vba::{decode_bytes, encode_string}`(既存、`pub`)
- Produces:
  - `pub enum ModuleKind { Document, Standard, Class, Form }` と `ModuleKind::as_str() -> &'static str`(`"document" | "standard" | "class" | "form"`)
  - `pub struct ProjectStream { pub lines: Vec<String> }`、`parse(bytes, code_page) -> Result<Self, String>`、`serialize(&self, code_page) -> Result<Vec<u8>, String>`、`module_kinds(&self) -> Vec<(String, ModuleKind)>`、`add_module(&mut self, name, kind)`、`remove_module(&mut self, name) -> bool`
  - `pub struct ProjectWm { pub names: Vec<String> }`、`parse(bytes, code_page)`、`serialize(&self, code_page)`、`add(&mut self, name)`、`remove(&mut self, name) -> bool`

- [ ] **Step 1: 失敗するテストを書く**

`src-tauri/src/commands/vba_streams.rs` を作り、まずテストだけ置く:

```rust
use crate::commands::vba::{decode_bytes, encode_string};

#[cfg(test)]
mod tests {
    use super::*;

    const PROJECT_TEXT: &str = "ID=\"{1}\"\r\nDocument=ThisWorkbook/&H00000000\r\nDocument=Sheet1/&H00000000\r\nModule=Module1\r\nClass=Class1\r\nName=\"VBAProject\"\r\nHelpContextID=\"0\"\r\n\r\n[Host Extender Info]\r\n&H00000001={3832D640-CF90-11CF-8E43-00A0C911005A};VBE;&H00000000\r\n";

    #[test]
    fn project_stream_round_trips_bytes() {
        let bytes = PROJECT_TEXT.as_bytes().to_vec();
        let ps = ProjectStream::parse(&bytes, 1252).unwrap();
        assert_eq!(ps.serialize(1252).unwrap(), bytes);
    }

    #[test]
    fn project_stream_lists_module_kinds() {
        let ps = ProjectStream::parse(PROJECT_TEXT.as_bytes(), 1252).unwrap();
        let kinds = ps.module_kinds();
        assert_eq!(kinds[0], ("ThisWorkbook".to_string(), ModuleKind::Document));
        assert_eq!(kinds[1], ("Sheet1".to_string(), ModuleKind::Document));
        assert_eq!(kinds[2], ("Module1".to_string(), ModuleKind::Standard));
        assert_eq!(kinds[3], ("Class1".to_string(), ModuleKind::Class));
        assert_eq!(kinds.len(), 4);
    }

    #[test]
    fn project_stream_add_inserts_after_last_module_line() {
        let mut ps = ProjectStream::parse(PROJECT_TEXT.as_bytes(), 1252).unwrap();
        ps.add_module("Helpers", ModuleKind::Standard);
        ps.add_module("NewClass", ModuleKind::Class);
        let text = String::from_utf8(ps.serialize(1252).unwrap()).unwrap();
        let idx = |s: &str| text.find(s).unwrap();
        assert!(idx("Class=Class1") < idx("Module=Helpers"));
        assert!(idx("Module=Helpers") < idx("Class=NewClass"));
        assert!(idx("Class=NewClass") < idx("Name=\"VBAProject\""));
    }

    #[test]
    fn project_stream_remove_drops_only_that_line() {
        let mut ps = ProjectStream::parse(PROJECT_TEXT.as_bytes(), 1252).unwrap();
        assert!(ps.remove_module("Module1"));
        assert!(!ps.remove_module("Nope"));
        let text = String::from_utf8(ps.serialize(1252).unwrap()).unwrap();
        assert!(!text.contains("Module=Module1"));
        assert!(text.contains("Class=Class1"));
        assert!(text.contains("[Host Extender Info]"));
    }

    #[test]
    fn project_stream_add_without_existing_modules_goes_after_id() {
        let mut ps = ProjectStream::parse(b"ID=\"{1}\"\r\nName=\"P\"\r\n", 1252).unwrap();
        ps.add_module("M", ModuleKind::Standard);
        assert_eq!(ps.lines[1], "Module=M");
    }

    fn wm_bytes(names: &[&str]) -> Vec<u8> {
        let mut v = Vec::new();
        for n in names {
            v.extend_from_slice(n.as_bytes());
            v.push(0);
            for u in n.encode_utf16() {
                v.extend_from_slice(&u.to_le_bytes());
            }
            v.extend_from_slice(&[0, 0]);
        }
        v.extend_from_slice(&[0, 0]);
        v
    }

    #[test]
    fn project_wm_round_trips() {
        let bytes = wm_bytes(&["ThisWorkbook", "Module1"]);
        let wm = ProjectWm::parse(&bytes, 1252).unwrap();
        assert_eq!(wm.names, vec!["ThisWorkbook", "Module1"]);
        assert_eq!(wm.serialize(1252).unwrap(), bytes);
    }

    #[test]
    fn project_wm_add_and_remove() {
        let mut wm = ProjectWm::parse(&wm_bytes(&["A"]), 1252).unwrap();
        wm.add("B");
        assert!(wm.remove("A"));
        assert!(!wm.remove("A"));
        assert_eq!(wm.serialize(1252).unwrap(), wm_bytes(&["B"]));
    }

    #[test]
    fn project_wm_empty_is_just_terminator() {
        let wm = ProjectWm::parse(&[0, 0], 1252).unwrap();
        assert!(wm.names.is_empty());
        assert_eq!(wm.serialize(1252).unwrap(), vec![0, 0]);
    }

    #[test]
    fn project_wm_handles_shift_jis_names() {
        let mut wm = ProjectWm { names: vec![] };
        wm.add("シート1");
        let bytes = wm.serialize(932).unwrap();
        let back = ProjectWm::parse(&bytes, 932).unwrap();
        assert_eq!(back.names, vec!["シート1"]);
    }
}
```

`mod.rs` に `pub mod vba_streams;` を追加。

- [ ] **Step 2: 失敗を確認**

Run: `cd src-tauri && cargo test vba_streams`
Expected: コンパイルエラー(`ProjectStream` 未定義)

- [ ] **Step 3: 実装**

テストの上に:

```rust
/// Module kinds as recorded in the PROJECT stream (MS-OVBA 2.3.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModuleKind {
    Document,
    Standard,
    Class,
    Form,
}

impl ModuleKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ModuleKind::Document => "document",
            ModuleKind::Standard => "standard",
            ModuleKind::Class => "class",
            ModuleKind::Form => "form",
        }
    }

    fn project_prefix(self) -> &'static str {
        match self {
            ModuleKind::Document => "Document=",
            ModuleKind::Standard => "Module=",
            ModuleKind::Class => "Class=",
            ModuleKind::Form => "BaseClass=",
        }
    }
}

const MODULE_LINE_PREFIXES: [&str; 4] = ["Document=", "Module=", "Class=", "BaseClass="];

/// The root `/PROJECT` stream: code-page text, CRLF separated. Only the
/// module lines are interpreted; everything else is carried through verbatim.
#[derive(Debug, Clone)]
pub struct ProjectStream {
    pub lines: Vec<String>,
}

impl ProjectStream {
    pub fn parse(bytes: &[u8], code_page: u16) -> Result<Self, String> {
        let text = decode_bytes(bytes, code_page)?;
        let lines = text.split("\r\n").map(|s| s.to_string()).collect();
        Ok(Self { lines })
    }

    pub fn serialize(&self, code_page: u16) -> Result<Vec<u8>, String> {
        encode_string(&self.lines.join("\r\n"), code_page)
    }

    fn parse_module_line(line: &str) -> Option<(String, ModuleKind)> {
        let kinds = [
            ModuleKind::Document,
            ModuleKind::Standard,
            ModuleKind::Class,
            ModuleKind::Form,
        ];
        for kind in kinds {
            if let Some(rest) = line.strip_prefix(kind.project_prefix()) {
                // "Document=Sheet1/&H00000000": the name ends at '/'.
                let name = rest.split('/').next().unwrap_or("").trim().to_string();
                if !name.is_empty() {
                    return Some((name, kind));
                }
            }
        }
        None
    }

    pub fn module_kinds(&self) -> Vec<(String, ModuleKind)> {
        self.lines.iter().filter_map(|l| Self::parse_module_line(l)).collect()
    }

    pub fn add_module(&mut self, name: &str, kind: ModuleKind) {
        let line = format!("{}{}", kind.project_prefix(), name);
        let last_module = self
            .lines
            .iter()
            .rposition(|l| MODULE_LINE_PREFIXES.iter().any(|p| l.starts_with(p)));
        let insert_at = match last_module {
            Some(i) => i + 1,
            None => match self.lines.iter().position(|l| l.starts_with("ID=")) {
                Some(i) => i + 1,
                None => 0,
            },
        };
        self.lines.insert(insert_at, line);
    }

    pub fn remove_module(&mut self, name: &str) -> bool {
        let before = self.lines.len();
        self.lines.retain(|l| {
            !matches!(Self::parse_module_line(l), Some((n, _)) if n.eq_ignore_ascii_case(name))
        });
        self.lines.len() != before
    }
}

/// The root `/PROJECTwm` stream (MS-OVBA 2.3.3): `<name MBCS>\0<name UTF-16LE>\0\0`
/// per module, terminated by `\0\0`.
#[derive(Debug, Clone)]
pub struct ProjectWm {
    pub names: Vec<String>,
}

impl ProjectWm {
    pub fn parse(bytes: &[u8], code_page: u16) -> Result<Self, String> {
        let mut names = Vec::new();
        let mut pos = 0;
        loop {
            if pos + 2 > bytes.len() || (bytes[pos] == 0 && bytes[pos + 1] == 0) {
                break;
            }
            let end = bytes[pos..]
                .iter()
                .position(|b| *b == 0)
                .ok_or("PROJECTwm: unterminated MBCS name")?;
            names.push(decode_bytes(&bytes[pos..pos + end], code_page)?);
            pos += end + 1;
            // Skip the UTF-16LE copy up to and including its 2-byte terminator.
            loop {
                if pos + 2 > bytes.len() {
                    return Err("PROJECTwm: unterminated Unicode name".to_string());
                }
                let unit = u16::from_le_bytes([bytes[pos], bytes[pos + 1]]);
                pos += 2;
                if unit == 0 {
                    break;
                }
            }
        }
        Ok(Self { names })
    }

    pub fn serialize(&self, code_page: u16) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        for name in &self.names {
            out.extend_from_slice(&encode_string(name, code_page)?);
            out.push(0);
            for unit in name.encode_utf16() {
                out.extend_from_slice(&unit.to_le_bytes());
            }
            out.extend_from_slice(&[0, 0]);
        }
        out.extend_from_slice(&[0, 0]);
        Ok(out)
    }

    pub fn add(&mut self, name: &str) {
        self.names.push(name.to_string());
    }

    pub fn remove(&mut self, name: &str) -> bool {
        let before = self.names.len();
        self.names.retain(|n| !n.eq_ignore_ascii_case(name));
        self.names.len() != before
    }
}
```

- [ ] **Step 4: テスト実行**

Run: `cd src-tauri && cargo test vba_streams`
Expected: 9 件 PASS

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/commands/vba_streams.rs src-tauri/src/commands/mod.rs
git commit -m "feat(vba): parse and edit the PROJECT and PROJECTwm streams"
```

### Task 3: `dir` ストリームのレコードモデル

**Files:**
- Modify: `src-tauri/src/commands/vba_streams.rs`
- Modify: `src-tauri/src/commands/vba.rs`(`parse_dir_stream` 385-530 行を `DirStream` の薄いラッパに)
- Test: `vba_streams.rs` の `mod tests`(既存の `test_parse_dir_stream_*` は vba.rs に残し、そのまま通す)

**Interfaces:**
- Produces:
  - `pub struct DirRecord { pub id: u16, pub data: Vec<u8> }`
  - `pub struct DirStream { pub records: Vec<DirRecord>, pub trailing: Vec<u8> }`
  - `DirStream::parse(&[u8]) -> Result<Self, String>`、`serialize(&self) -> Vec<u8>`、`code_page(&self) -> u16`、`module_count(&self) -> Option<u16>`、`set_module_count(&mut self, u16) -> Result<(), String>`
  - `pub struct DirModule { pub name: String, pub stream_name: String, pub type_id: u16, pub text_offset: u32 }`、`DirStream::modules(&self) -> Vec<DirModule>`
  - `DirStream::append_module(&mut self, name, stream_name, kind: ModuleKind, text_offset: u32, code_page: u16) -> Result<(), String>`(件数も更新)
  - `DirStream::remove_module(&mut self, name) -> bool`(件数も更新)
  - 定数 `pub const REC_PROJECTCODEPAGE: u16 = 0x0003;` 等(下記)

- [ ] **Step 1: 失敗するテストを書く**

`vba_streams.rs` の `mod tests` に追加:

```rust
    fn rec(id: u16, data: &[u8]) -> Vec<u8> {
        let mut v = id.to_le_bytes().to_vec();
        v.extend_from_slice(&(data.len() as u32).to_le_bytes());
        v.extend_from_slice(data);
        v
    }

    /// Minimal project header: SYSKIND, VERSION (odd size), CODEPAGE, NAME,
    /// MODULES(count), COOKIE, then modules, then TERMINATOR.
    fn dir_bytes_with_modules(count: u16, modules: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&rec(0x0001, &3u32.to_le_bytes()));
        // PROJECTVERSION: size says 4 but 6 bytes follow (Major u32 + Minor u16).
        v.extend_from_slice(&0x0009u16.to_le_bytes());
        v.extend_from_slice(&4u32.to_le_bytes());
        v.extend_from_slice(&0x0000_0001u32.to_le_bytes());
        v.extend_from_slice(&0x0002u16.to_le_bytes());
        v.extend_from_slice(&rec(0x0003, &1252u16.to_le_bytes()));
        v.extend_from_slice(&rec(0x0004, b"VBAProject"));
        v.extend_from_slice(&rec(0x000F, &count.to_le_bytes()));
        v.extend_from_slice(&rec(0x0013, &0xFFFFu16.to_le_bytes()));
        v.extend_from_slice(modules);
        v.extend_from_slice(&rec(0x0010, &[]));
        v
    }

    fn module_bytes(name: &str, type_id: u16, offset: u32) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&rec(0x0019, name.as_bytes()));
        let utf16: Vec<u8> = name.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        v.extend_from_slice(&rec(0x0047, &utf16));
        v.extend_from_slice(&rec(0x001A, name.as_bytes()));
        v.extend_from_slice(&rec(0x0032, &utf16));
        v.extend_from_slice(&rec(0x001C, &[]));
        v.extend_from_slice(&rec(0x0048, &[]));
        v.extend_from_slice(&rec(0x0031, &offset.to_le_bytes()));
        v.extend_from_slice(&rec(0x001E, &0u32.to_le_bytes()));
        v.extend_from_slice(&rec(0x002C, &0xFFFFu16.to_le_bytes()));
        v.extend_from_slice(&rec(type_id, &[]));
        v.extend_from_slice(&rec(0x002B, &[]));
        v
    }

    #[test]
    fn dir_stream_round_trips_including_project_version_quirk() {
        let mut mods = module_bytes("Module1", 0x0021, 100);
        mods.extend_from_slice(&module_bytes("Sheet1", 0x0022, 0));
        let bytes = dir_bytes_with_modules(2, &mods);
        let dir = DirStream::parse(&bytes).unwrap();
        assert_eq!(dir.serialize(), bytes);
        assert_eq!(dir.code_page(), 1252);
        assert_eq!(dir.module_count(), Some(2));
    }

    #[test]
    fn dir_stream_lists_modules() {
        let mut mods = module_bytes("Module1", 0x0021, 100);
        mods.extend_from_slice(&module_bytes("Sheet1", 0x0022, 0));
        let dir = DirStream::parse(&dir_bytes_with_modules(2, &mods)).unwrap();
        let m = dir.modules();
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].name, "Module1");
        assert_eq!(m[0].stream_name, "Module1");
        assert_eq!(m[0].type_id, 0x0021);
        assert_eq!(m[0].text_offset, 100);
        assert_eq!(m[1].name, "Sheet1");
        assert_eq!(m[1].type_id, 0x0022);
    }

    #[test]
    fn dir_stream_append_module_matches_hand_built_records_and_bumps_count() {
        let mut dir = DirStream::parse(&dir_bytes_with_modules(0, &[])).unwrap();
        dir.append_module("Helpers", "Helpers", ModuleKind::Standard, 0, 1252).unwrap();
        let expected = dir_bytes_with_modules(1, &module_bytes("Helpers", 0x0021, 0));
        assert_eq!(dir.serialize(), expected);
        assert_eq!(dir.module_count(), Some(1));
    }

    #[test]
    fn dir_stream_append_class_uses_type_0x22() {
        let mut dir = DirStream::parse(&dir_bytes_with_modules(0, &[])).unwrap();
        dir.append_module("C", "C", ModuleKind::Class, 0, 1252).unwrap();
        assert_eq!(dir.modules()[0].type_id, 0x0022);
    }

    #[test]
    fn dir_stream_remove_module_keeps_neighbours_and_decrements_count() {
        let mut mods = module_bytes("Module1", 0x0021, 100);
        mods.extend_from_slice(&module_bytes("Old", 0x0021, 0));
        mods.extend_from_slice(&module_bytes("Sheet1", 0x0022, 0));
        let mut dir = DirStream::parse(&dir_bytes_with_modules(3, &mods)).unwrap();
        assert!(dir.remove_module("old")); // case-insensitive
        assert!(!dir.remove_module("Old"));
        let mut keep = module_bytes("Module1", 0x0021, 100);
        keep.extend_from_slice(&module_bytes("Sheet1", 0x0022, 0));
        assert_eq!(dir.serialize(), dir_bytes_with_modules(2, &keep));
    }

    #[test]
    fn dir_stream_set_module_count_requires_record() {
        let mut dir = DirStream::parse(&rec(0x0010, &[])).unwrap();
        assert!(dir.set_module_count(1).is_err());
    }

    #[test]
    fn dir_stream_rejects_truncated_record() {
        let mut bytes = rec(0x0003, &1252u16.to_le_bytes());
        bytes.truncate(bytes.len() - 1);
        assert!(DirStream::parse(&bytes).is_err());
    }
```

- [ ] **Step 2: 失敗を確認**

Run: `cd src-tauri && cargo test vba_streams::tests::dir_stream`
Expected: コンパイルエラー(`DirStream` 未定義)

- [ ] **Step 3: 実装**

`vba_streams.rs` に追加:

```rust
// dir stream record ids (MS-OVBA 2.3.4.2)
pub const REC_PROJECTCODEPAGE: u16 = 0x0003;
pub const REC_PROJECTVERSION: u16 = 0x0009;
pub const REC_PROJECTMODULES: u16 = 0x000F;
pub const REC_PROJECTTERMINATOR: u16 = 0x0010;
pub const REC_MODULENAME: u16 = 0x0019;
pub const REC_MODULESTREAMNAME: u16 = 0x001A;
pub const REC_MODULEDOCSTRING: u16 = 0x001C;
pub const REC_MODULEHELPCONTEXT: u16 = 0x001E;
pub const REC_MODULETYPE_PROCEDURAL: u16 = 0x0021;
pub const REC_MODULETYPE_OTHER: u16 = 0x0022;
pub const REC_MODULETERMINATOR: u16 = 0x002B;
pub const REC_MODULECOOKIE: u16 = 0x002C;
pub const REC_MODULEOFFSET: u16 = 0x0031;
pub const REC_MODULESTREAMNAMEUNICODE: u16 = 0x0032;
pub const REC_MODULENAMEUNICODE: u16 = 0x0047;
pub const REC_MODULEDOCSTRINGUNICODE: u16 = 0x0048;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirRecord {
    pub id: u16,
    /// Raw payload. For PROJECTVERSION this holds all 6 bytes even though the
    /// on-disk size field says 4 (MS-OVBA 2.3.4.2.1.10).
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DirModule {
    pub name: String,
    pub stream_name: String,
    pub type_id: u16,
    pub text_offset: u32,
}

/// The decompressed `/VBA/dir` stream as a flat record list. Unknown records
/// are preserved byte-for-byte so `serialize` reproduces the input exactly.
#[derive(Debug, Clone)]
pub struct DirStream {
    pub records: Vec<DirRecord>,
    /// Bytes after PROJECTTERMINATOR, if any (carried through unchanged).
    pub trailing: Vec<u8>,
}

impl DirStream {
    pub fn parse(data: &[u8]) -> Result<Self, String> {
        let mut records = Vec::new();
        let mut pos = 0usize;
        while pos + 6 <= data.len() {
            let id = u16::from_le_bytes([data[pos], data[pos + 1]]);
            let declared = u32::from_le_bytes([data[pos + 2], data[pos + 3], data[pos + 4], data[pos + 5]]) as usize;
            pos += 6;
            let size = if id == REC_PROJECTVERSION { declared + 2 } else { declared };
            if pos + size > data.len() {
                return Err(format!(
                    "dir record 0x{:04X} at {} claims {} bytes but {} remain",
                    id, pos - 6, size, data.len() - pos
                ));
            }
            records.push(DirRecord { id, data: data[pos..pos + size].to_vec() });
            pos += size;
            if id == REC_PROJECTTERMINATOR {
                break;
            }
        }
        if pos < data.len() && records.last().map(|r| r.id) != Some(REC_PROJECTTERMINATOR) {
            return Err("dir stream ends with a partial record".to_string());
        }
        Ok(Self { records, trailing: data[pos..].to_vec() })
    }

    pub fn serialize(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for r in &self.records {
            out.extend_from_slice(&r.id.to_le_bytes());
            let declared = if r.id == REC_PROJECTVERSION { r.data.len().saturating_sub(2) } else { r.data.len() };
            out.extend_from_slice(&(declared as u32).to_le_bytes());
            out.extend_from_slice(&r.data);
        }
        out.extend_from_slice(&self.trailing);
        out
    }

    pub fn code_page(&self) -> u16 {
        self.records
            .iter()
            .find(|r| r.id == REC_PROJECTCODEPAGE && r.data.len() >= 2)
            .map(|r| u16::from_le_bytes([r.data[0], r.data[1]]))
            .unwrap_or(1252)
    }

    pub fn module_count(&self) -> Option<u16> {
        self.records
            .iter()
            .find(|r| r.id == REC_PROJECTMODULES && r.data.len() >= 2)
            .map(|r| u16::from_le_bytes([r.data[0], r.data[1]]))
    }

    pub fn set_module_count(&mut self, count: u16) -> Result<(), String> {
        let rec = self
            .records
            .iter_mut()
            .find(|r| r.id == REC_PROJECTMODULES)
            .ok_or("dir stream has no PROJECTMODULES record")?;
        rec.data = count.to_le_bytes().to_vec();
        Ok(())
    }

    /// (start index of MODULENAME, index of MODULETERMINATOR) for each module.
    fn module_ranges(&self) -> Vec<(usize, usize)> {
        let mut ranges = Vec::new();
        let mut start: Option<usize> = None;
        for (i, r) in self.records.iter().enumerate() {
            if r.id == REC_MODULENAME && start.is_none() {
                start = Some(i);
            } else if r.id == REC_MODULETERMINATOR {
                if let Some(s) = start.take() {
                    ranges.push((s, i));
                }
            }
        }
        ranges
    }

    fn utf16_string(data: &[u8]) -> Option<String> {
        let units: Vec<u16> = data.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16(&units).ok()
    }

    pub fn modules(&self) -> Vec<DirModule> {
        let code_page = self.code_page();
        self.module_ranges()
            .into_iter()
            .map(|(s, e)| {
                let recs = &self.records[s..=e];
                let text = |id: u16| recs.iter().find(|r| r.id == id).map(|r| r.data.as_slice());
                let mbcs = |id: u16| text(id).map(|d| decode_bytes(d, code_page).unwrap_or_else(|_| String::from_utf8_lossy(d).into_owned()));
                let name = text(REC_MODULENAMEUNICODE)
                    .and_then(Self::utf16_string)
                    .or_else(|| mbcs(REC_MODULENAME))
                    .unwrap_or_default();
                let stream_name = text(REC_MODULESTREAMNAMEUNICODE)
                    .and_then(Self::utf16_string)
                    .or_else(|| mbcs(REC_MODULESTREAMNAME))
                    .unwrap_or_else(|| name.clone());
                let type_id = recs
                    .iter()
                    .find(|r| r.id == REC_MODULETYPE_PROCEDURAL || r.id == REC_MODULETYPE_OTHER)
                    .map(|r| r.id)
                    .unwrap_or(REC_MODULETYPE_PROCEDURAL);
                let text_offset = text(REC_MODULEOFFSET)
                    .filter(|d| d.len() >= 4)
                    .map(|d| u32::from_le_bytes([d[0], d[1], d[2], d[3]]))
                    .unwrap_or(0);
                DirModule { name, stream_name, type_id, text_offset }
            })
            .collect()
    }

    pub fn append_module(
        &mut self,
        name: &str,
        stream_name: &str,
        kind: ModuleKind,
        text_offset: u32,
        code_page: u16,
    ) -> Result<(), String> {
        let utf16 = |s: &str| -> Vec<u8> { s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect() };
        let type_id = match kind {
            ModuleKind::Standard => REC_MODULETYPE_PROCEDURAL,
            _ => REC_MODULETYPE_OTHER,
        };
        let new_records = vec![
            DirRecord { id: REC_MODULENAME, data: encode_string(name, code_page)? },
            DirRecord { id: REC_MODULENAMEUNICODE, data: utf16(name) },
            DirRecord { id: REC_MODULESTREAMNAME, data: encode_string(stream_name, code_page)? },
            DirRecord { id: REC_MODULESTREAMNAMEUNICODE, data: utf16(stream_name) },
            DirRecord { id: REC_MODULEDOCSTRING, data: vec![] },
            DirRecord { id: REC_MODULEDOCSTRINGUNICODE, data: vec![] },
            DirRecord { id: REC_MODULEOFFSET, data: text_offset.to_le_bytes().to_vec() },
            DirRecord { id: REC_MODULEHELPCONTEXT, data: 0u32.to_le_bytes().to_vec() },
            DirRecord { id: REC_MODULECOOKIE, data: 0xFFFFu16.to_le_bytes().to_vec() },
            DirRecord { id: type_id, data: vec![] },
            DirRecord { id: REC_MODULETERMINATOR, data: vec![] },
        ];
        let at = self
            .records
            .iter()
            .position(|r| r.id == REC_PROJECTTERMINATOR)
            .unwrap_or(self.records.len());
        self.records.splice(at..at, new_records);
        let count = self.module_ranges().len() as u16;
        self.set_module_count(count)
    }

    pub fn remove_module(&mut self, name: &str) -> bool {
        let target = self
            .modules()
            .iter()
            .zip(self.module_ranges())
            .find(|(m, _)| m.name.eq_ignore_ascii_case(name))
            .map(|(_, range)| range);
        match target {
            Some((s, e)) => {
                self.records.drain(s..=e);
                let count = self.module_ranges().len() as u16;
                let _ = self.set_module_count(count);
                true
            }
            None => false,
        }
    }
}
```

`vba.rs` の `parse_dir_stream` 本体を次に置き換える(シグネチャと `VbaProject` / `VbaModuleInfo` は維持、既存テストはそのまま通る):

```rust
pub fn parse_dir_stream(data: &[u8]) -> Result<VbaProject, String> {
    let dir = DirStream::parse(data)?;
    let code_page = dir.code_page();
    let modules = dir
        .modules()
        .into_iter()
        .map(|m| VbaModuleInfo {
            name: m.name,
            stream_name: m.stream_name,
            module_type: if m.type_id == REC_MODULETYPE_PROCEDURAL { "standard" } else { "class" }.to_string(),
            text_offset: m.text_offset,
        })
        .collect();
    Ok(VbaProject { code_page, modules })
}
```

(`use crate::commands::vba_streams::{DirStream, REC_MODULETYPE_PROCEDURAL};` を追加。古い手書きのレコードループは削除。)

- [ ] **Step 4: テスト実行**

Run: `cd src-tauri && cargo test vba`
Expected: `vba_streams` の dir テスト 7 件と `vba::tests::test_parse_dir_stream_*` が PASS

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/commands/vba_streams.rs src-tauri/src/commands/vba.rs
git commit -m "feat(vba): record-level dir stream model with append and remove"
```

### Task 4: ソース正規化とモジュール名検証

**Files:**
- Create: `src-tauri/src/commands/vba_source.rs`
- Modify: `src-tauri/src/commands/mod.rs`(`pub mod vba_source;`)
- Modify: `src-tauri/src/commands/vba.rs`(`extract_vb_name` / `fix_vb_name` 751-808 行と `test_fix_vb_name_*` 4 本を `vba_source.rs` へ移動。vba.rs 側は `use crate::commands::vba_source::{extract_vb_name, fix_vb_name};`)
- Test: `vba_source.rs` の `mod tests`

**Interfaces:**
- Produces:
  - `pub fn extract_vb_name(source: &str) -> Option<String>`、`pub fn fix_vb_name(source: &str, expected_name: &str) -> String`(移動、`pub` に)
  - `pub fn normalize_source(source: &str, module_name: &str, kind: ModuleKind) -> String`
  - `pub fn validate_module_name(name: &str, existing: &[String]) -> Result<(), String>`(Err はメッセージ文字列。JSON 化は呼び出し側)
  - `pub const VBA_KEYWORDS: &[&str]`

- [ ] **Step 1: 失敗するテストを書く**

`vba_source.rs`(移動したテストの後ろに):

```rust
    // --- normalize_source ---

    #[test]
    fn normalize_strips_bom_and_unifies_crlf() {
        let src = "\u{FEFF}Attribute VB_Name = \"M\"\nSub A()\rEnd Sub";
        let out = normalize_source(src, "M", ModuleKind::Standard);
        assert_eq!(out, "Attribute VB_Name = \"M\"\r\nSub A()\r\nEnd Sub\r\n");
    }

    #[test]
    fn normalize_inserts_vb_name_when_missing() {
        let out = normalize_source("Sub A()\r\nEnd Sub\r\n", "Helpers", ModuleKind::Standard);
        assert!(out.starts_with("Attribute VB_Name = \"Helpers\"\r\nSub A()"));
    }

    #[test]
    fn normalize_fixes_vb_name_to_file_name() {
        let out = normalize_source("Attribute VB_Name = \"Old\"\r\nSub A()\r\nEnd Sub\r\n", "New", ModuleKind::Standard);
        assert!(out.starts_with("Attribute VB_Name = \"New\"\r\n"));
        assert!(!out.contains("Old"));
    }

    #[test]
    fn normalize_strips_version_header_from_class_and_adds_attributes() {
        let src = "VERSION 1.0 CLASS\r\nBEGIN\r\n  MultiUse = -1  'True\r\nEND\r\nAttribute VB_Name = \"C\"\r\nPublic Sub Hi()\r\nEnd Sub\r\n";
        let out = normalize_source(src, "C", ModuleKind::Class);
        let expected = "Attribute VB_Name = \"C\"\r\nAttribute VB_GlobalNameSpace = False\r\nAttribute VB_Creatable = False\r\nAttribute VB_PredeclaredId = False\r\nAttribute VB_Exposed = False\r\nPublic Sub Hi()\r\nEnd Sub\r\n";
        assert_eq!(out, expected);
    }

    #[test]
    fn normalize_keeps_existing_class_attributes() {
        let src = "Attribute VB_Name = \"C\"\r\nAttribute VB_GlobalNameSpace = False\r\nAttribute VB_Creatable = False\r\nAttribute VB_PredeclaredId = True\r\nAttribute VB_Exposed = False\r\nSub X()\r\nEnd Sub\r\n";
        let out = normalize_source(src, "C", ModuleKind::Class);
        assert_eq!(out, src);
        assert_eq!(out.matches("VB_PredeclaredId").count(), 1);
    }

    #[test]
    fn normalize_does_not_add_class_attributes_to_standard_modules() {
        let out = normalize_source("Attribute VB_Name = \"M\"\r\nSub X()\r\nEnd Sub\r\n", "M", ModuleKind::Standard);
        assert!(!out.contains("VB_Exposed"));
    }

    // --- validate_module_name ---

    #[test]
    fn valid_names_pass() {
        assert!(validate_module_name("Helpers", &[]).is_ok());
        assert!(validate_module_name("mod_2", &["Module1".into()]).is_ok());
    }

    #[test]
    fn names_must_start_with_a_letter_and_be_ascii_identifiers() {
        assert!(validate_module_name("1bad", &[]).is_err());
        assert!(validate_module_name("_x", &[]).is_err());
        assert!(validate_module_name("bad-name", &[]).is_err());
        assert!(validate_module_name("日本", &[]).is_err());
        assert!(validate_module_name("", &[]).is_err());
    }

    #[test]
    fn names_are_limited_to_31_chars() {
        assert!(validate_module_name(&"a".repeat(31), &[]).is_ok());
        assert!(validate_module_name(&"a".repeat(32), &[]).is_err());
    }

    #[test]
    fn names_must_not_collide_case_insensitively() {
        assert!(validate_module_name("module1", &["Module1".into()]).is_err());
    }

    #[test]
    fn names_must_not_be_keywords() {
        assert!(validate_module_name("Sub", &[]).is_err());
        assert!(validate_module_name("attribute", &[]).is_err());
    }
```

- [ ] **Step 2: 失敗を確認**

Run: `cd src-tauri && cargo test vba_source`
Expected: コンパイルエラー

- [ ] **Step 3: 実装**

`vba_source.rs`:

```rust
use crate::commands::vba_streams::ModuleKind;

/// Reserved identifiers (MS-VBAL 3.3.5.2). A module may not use one as its name.
pub const VBA_KEYWORDS: &[&str] = &[
    "Abs", "Access", "AddressOf", "Alias", "And", "Any", "Append", "As", "Attribute", "Base",
    "Binary", "Boolean", "ByRef", "Byte", "ByVal", "Call", "Case", "CBool", "CByte", "CCur",
    "CDate", "CDbl", "CDec", "CDecl", "Circle", "CInt", "CLng", "CLngLng", "CLngPtr", "Close",
    "Compare", "Const", "CSng", "CStr", "Currency", "CVar", "CVErr", "Database", "Date", "Debug",
    "Decimal", "Declare", "DefBool", "DefByte", "DefCur", "DefDate", "DefDbl", "DefDec", "DefInt",
    "DefLng", "DefLngLng", "DefLngPtr", "DefObj", "DefSng", "DefStr", "DefVar", "Dim", "Do",
    "DoEvents", "Double", "Each", "Else", "ElseIf", "Empty", "End", "EndIf", "Enum", "Eqv",
    "Erase", "Error", "Event", "Exit", "Explicit", "False", "Fix", "For", "Friend", "Function",
    "Get", "Global", "GoSub", "GoTo", "If", "Imp", "Implements", "In", "Input", "InputB", "Int",
    "Integer", "Is", "LBound", "Len", "LenB", "Let", "Lib", "Like", "Line", "Lock", "Long",
    "LongLong", "LongPtr", "Loop", "LSet", "Me", "Mid", "MidB", "Mod", "Module", "New", "Next",
    "Not", "Nothing", "Null", "Object", "On", "Open", "Option", "Optional", "Or", "Output",
    "ParamArray", "Preserve", "Print", "Private", "Property", "PSet", "Public", "Put", "Random",
    "Read", "ReDim", "Rem", "Reset", "Resume", "Return", "RSet", "Scale", "Seek", "Select",
    "Set", "Sgn", "Shared", "Single", "Spc", "Static", "Step", "Stop", "String", "Sub", "Tab",
    "Text", "Then", "To", "True", "Type", "TypeOf", "UBound", "Unlock", "Until", "Variant",
    "Wend", "While", "Width", "With", "WithEvents", "Write", "Xor",
];

const CLASS_ATTRIBUTES: [&str; 4] = [
    "Attribute VB_GlobalNameSpace = False",
    "Attribute VB_Creatable = False",
    "Attribute VB_PredeclaredId = False",
    "Attribute VB_Exposed = False",
];

// (extract_vb_name and fix_vb_name moved here verbatim from vba.rs, made `pub`)

/// Shape a module file the way VBA stores it inside vbaProject.bin:
/// no BOM, CRLF, no exported-.cls VERSION header, `Attribute VB_Name` equal
/// to the file name, and the four standard class attributes for classes.
pub fn normalize_source(source: &str, module_name: &str, kind: ModuleKind) -> String {
    let text = source.strip_prefix('\u{FEFF}').unwrap_or(source);
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }

    // Drop a leading "VERSION 1.0 CLASS" ... "END" block (VBE export format).
    let first_non_empty = lines.iter().position(|l| !l.trim().is_empty());
    if let Some(i) = first_non_empty {
        let head = lines[i].trim();
        if head.to_ascii_uppercase().starts_with("VERSION ") && head.to_ascii_uppercase().contains("CLASS") {
            if let Some(end) = lines[i..].iter().position(|l| l.trim().eq_ignore_ascii_case("END")) {
                lines.drain(i..=i + end);
            }
        }
    }

    let mut joined = lines.join("\r\n");
    joined.push_str("\r\n");

    let mut out = if extract_vb_name(&joined).is_some() {
        fix_vb_name(&joined, module_name)
    } else {
        format!("Attribute VB_Name = \"{}\"\r\n{}", module_name, joined)
    };

    if kind == ModuleKind::Class {
        let has = |attr: &str| {
            let key = attr.split('=').next().unwrap().trim().to_ascii_lowercase();
            out.lines().any(|l| l.trim().to_ascii_lowercase().starts_with(&key))
        };
        let missing: Vec<&str> = CLASS_ATTRIBUTES.iter().copied().filter(|a| !has(a)).collect();
        if !missing.is_empty() {
            let name_line_end = out.find("\r\n").map(|i| i + 2).unwrap_or(out.len());
            let insert = missing.iter().map(|a| format!("{}\r\n", a)).collect::<String>();
            out.insert_str(name_line_end, &insert);
        }
    }
    out
}

pub fn validate_module_name(name: &str, existing: &[String]) -> Result<(), String> {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return Err(format!("'{}': module names must start with a letter", name)),
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(format!("'{}': only ASCII letters, digits and '_' are allowed", name));
    }
    if name.len() > 31 {
        return Err(format!("'{}': module names are limited to 31 characters", name));
    }
    if VBA_KEYWORDS.iter().any(|k| k.eq_ignore_ascii_case(name)) {
        return Err(format!("'{}' is a VBA reserved word", name));
    }
    if existing.iter().any(|e| e.eq_ignore_ascii_case(name)) {
        return Err(format!("'{}' already exists (names are case-insensitive)", name));
    }
    Ok(())
}
```

- [ ] **Step 4: テスト実行**

Run: `cd src-tauri && cargo test vba`
Expected: `vba_source` 15 件 PASS、vba.rs の既存テストも PASS

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/commands/vba_source.rs src-tauri/src/commands/vba.rs src-tauri/src/commands/mod.rs
git commit -m "feat(vba): source normalization and module name validation"
```

### Task 5: `push_vba_modules`(更新・追加・削除)と合成ブックでの往復テスト

**Files:**
- Modify: `src-tauri/src/commands/vba.rs`(`inject_vba_modules` 811-1086 行を `push_vba_modules` に置き換え、`test_inject_error_*` 2 本を削除、`pull_vba_modules` / `list_vba_modules` の種別判定を `PROJECT` ベースに)
- Modify: `src-tauri/src/lib.rs`(`inject_vba_modules` → `push_vba_modules`)
- Test: `vba.rs` の `mod tests`

**Interfaces:**
- Consumes: Task 2-4 の `DirStream` / `ProjectStream` / `ProjectWm` / `ModuleKind` / `normalize_source` / `validate_module_name`、Task 1 の `macros_dir_for` / `workbook_lock` / `vba_error` / `require_macro_workbook`
- Produces:
  - `pub struct PushResult { xlsm_path, backup_path, updated: Vec<String>, unchanged: Vec<String>, added: Vec<String>, removed: Vec<String>, skipped: Vec<SkippedModule> }`、`pub struct SkippedModule { name, reason }`(camelCase)
  - `pub fn push_vba_modules_impl(xlsm_path: &str) -> Result<PushResult, String>`(ブリッジが呼ぶ)
  - `#[tauri::command] push_vba_modules(app: AppHandle, xlsm_path: String) -> Result<PushResult, String>`(成功時 `app.emit("vba-pushed", {"path"})`)
  - `pub(crate) struct LoadedProject` と `pub(crate) fn load_project(vba_bin: Vec<u8>) -> Result<LoadedProject, String>`(list / pull も使う)
  - エラーコード: `invalid_workbook` `no_vba_project` `macros_dir_not_found` `workbook_locked` `duplicate_module_file` `invalid_module_name` `unencodable_character` `pull_failed` `push_failed` `list_failed`

- [ ] **Step 1: 失敗するテストを書く**

`mod tests` に合成ブックのビルダーと往復テストを追加(`test_inject_error_*` 2 本は削除):

```rust
    // --- synthetic workbook for pull/push round trips (no Excel needed) ---

    use crate::commands::vba_streams::{DirStream, ModuleKind, ProjectStream, ProjectWm};

    struct TestModule {
        name: &'static str,
        kind: ModuleKind,
        source: &'static str,
        /// Fake PerformanceCache bytes placed before the compressed source.
        cache: &'static [u8],
    }

    fn build_vba_bin(code_page: u16, modules: &[TestModule]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut comp = cfb::CompoundFile::create(cursor).unwrap();
        comp.create_storage("/VBA").unwrap();

        let mut project = ProjectStream { lines: vec!["ID=\"{1}\"".into(), "Name=\"VBAProject\"".into(), "".into()] };
        let mut wm = ProjectWm { names: vec![] };
        let mut dir = DirStream::parse(&{
            let mut v = Vec::new();
            v.extend_from_slice(&make_record(0x0001, &3u32.to_le_bytes()));
            v.extend_from_slice(&make_record(0x0003, &code_page.to_le_bytes()));
            v.extend_from_slice(&make_record(0x000F, &0u16.to_le_bytes()));
            v.extend_from_slice(&make_record(0x0013, &0xFFFFu16.to_le_bytes()));
            v.extend_from_slice(&make_record(0x0010, &[]));
            v
        })
        .unwrap();

        for m in modules {
            project.add_module(m.name, m.kind);
            wm.add(m.name);
            dir.append_module(m.name, m.name, m.kind, m.cache.len() as u32, code_page).unwrap();
            let mut data = m.cache.to_vec();
            data.extend_from_slice(&vba_compress(&encode_string(m.source, code_page).unwrap()));
            comp.create_stream(&format!("/VBA/{}", m.name)).unwrap().write_all(&data).unwrap();
        }
        comp.create_stream("/PROJECT").unwrap().write_all(&project.serialize(code_page).unwrap()).unwrap();
        comp.create_stream("/PROJECTwm").unwrap().write_all(&wm.serialize(code_page).unwrap()).unwrap();
        comp.create_stream("/VBA/dir").unwrap().write_all(&vba_compress(&dir.serialize())).unwrap();
        comp.create_stream("/VBA/_VBA_PROJECT").unwrap().write_all(&[0xCC, 0x61, 0xFF, 0xFF, 0x00, 0x00, 0x00]).unwrap();
        comp.flush().unwrap();
        comp.into_inner().into_inner()
    }

    fn build_workbook(dir: &Path, file_name: &str, vba_bin: &[u8]) -> PathBuf {
        let path = dir.join(file_name);
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        zip.start_file("[Content_Types].xml", opts).unwrap();
        zip.write_all(b"<Types/>").unwrap();
        zip.start_file("xl/workbook.xml", opts).unwrap();
        zip.write_all(b"<workbook/>").unwrap();
        zip.start_file("xl/vbaProject.bin", opts).unwrap();
        zip.write_all(vba_bin).unwrap();
        zip.finish().unwrap();
        path
    }

    fn std_module(name: &'static str, body: &'static str) -> TestModule {
        TestModule { name, kind: ModuleKind::Standard, source: body, cache: &[] }
    }

    fn three_module_workbook(dir: &Path) -> PathBuf {
        let bin = build_vba_bin(
            1252,
            &[
                std_module("Module1", "Attribute VB_Name = \"Module1\"\r\nSub Hello()\r\nEnd Sub\r\n"),
                // Carries the four class attributes VBE stores, so a pull→push
                // round trip without edits is reported as unchanged.
                TestModule { name: "Class1", kind: ModuleKind::Class, source: "Attribute VB_Name = \"Class1\"\r\nAttribute VB_GlobalNameSpace = False\r\nAttribute VB_Creatable = False\r\nAttribute VB_PredeclaredId = False\r\nAttribute VB_Exposed = False\r\nPublic Sub Hi()\r\nEnd Sub\r\n", cache: &[] },
                TestModule { name: "ThisWorkbook", kind: ModuleKind::Document, source: "Attribute VB_Name = \"ThisWorkbook\"\r\n", cache: &[9, 9, 9, 9, 9] },
            ],
        );
        build_workbook(dir, "Book1.xlsm", &bin)
    }

    fn stream_bytes(xlsm: &Path, stream: &str) -> Vec<u8> {
        let bin = read_vba_project_bin(xlsm.to_str().unwrap()).unwrap();
        let mut comp = cfb::CompoundFile::open(Cursor::new(bin)).unwrap();
        let mut buf = Vec::new();
        comp.open_stream(stream).unwrap().read_to_end(&mut buf).unwrap();
        buf
    }

    fn err_code(err: &str) -> String {
        serde_json::from_str::<serde_json::Value>(err).map(|v| v["error"].as_str().unwrap_or("").to_string()).unwrap_or_default()
    }

    #[test]
    fn pull_writes_files_and_list_reports_kinds_from_project_stream() {
        let tmp = tempfile::tempdir().unwrap();
        let xlsm = three_module_workbook(tmp.path());
        let xlsm_s = xlsm.to_string_lossy().to_string();

        let before = list_vba_modules(xlsm_s.clone()).unwrap();
        assert!(!before.extracted);
        assert!(before.modules.iter().all(|m| m.path.is_none()));

        let pulled = pull_vba_modules(xlsm_s.clone()).unwrap();
        assert_eq!(pulled.macros_dir, tmp.path().join("Book1_assets").join("macros").to_string_lossy());
        let kinds: Vec<(String, String)> = pulled.modules.iter().map(|m| (m.name.clone(), m.module_type.clone())).collect();
        assert_eq!(kinds, vec![
            ("Module1".to_string(), "standard".to_string()),
            ("Class1".to_string(), "class".to_string()),
            ("ThisWorkbook".to_string(), "document".to_string()),
        ]);
        assert!(Path::new(&pulled.macros_dir).join("Module1.bas").exists());
        assert!(Path::new(&pulled.macros_dir).join("Class1.cls").exists());
        assert!(Path::new(&pulled.macros_dir).join("ThisWorkbook.cls").exists());

        let after = list_vba_modules(xlsm_s).unwrap();
        assert!(after.extracted);
        assert!(after.modules.iter().all(|m| m.path.is_some()));
    }

    #[test]
    fn push_updates_adds_removes_and_skips_document_modules() {
        let tmp = tempfile::tempdir().unwrap();
        let xlsm = three_module_workbook(tmp.path());
        let xlsm_s = xlsm.to_string_lossy().to_string();
        let macros = Path::new(&pull_vba_modules(xlsm_s.clone()).unwrap().macros_dir).to_path_buf();

        fs::write(macros.join("Module1.bas"), "Attribute VB_Name = \"Module1\"\r\nSub Hello(name As String)\r\nEnd Sub\r\n").unwrap();
        fs::write(macros.join("Helpers.bas"), "Sub Help()\r\nEnd Sub\r\n").unwrap();
        fs::write(macros.join("NewClass.cls"), "VERSION 1.0 CLASS\r\nBEGIN\r\n  MultiUse = -1  'True\r\nEND\r\nAttribute VB_Name = \"NewClass\"\r\nPublic Sub Go()\r\nEnd Sub\r\n").unwrap();
        fs::remove_file(macros.join("Class1.cls")).unwrap();
        fs::remove_file(macros.join("ThisWorkbook.cls")).unwrap();

        let res = push_vba_modules_impl(&xlsm_s).unwrap();
        assert_eq!(res.updated, vec!["Module1"]);
        assert!(res.unchanged.is_empty());
        assert_eq!(res.added, vec!["Helpers", "NewClass"]);
        assert_eq!(res.removed, vec!["Class1"]);
        assert_eq!(res.skipped.len(), 1);
        assert_eq!(res.skipped[0].name, "ThisWorkbook");
        assert!(Path::new(&res.backup_path).exists());

        // Document module stream (including its fake cache prefix) is untouched.
        let tw = stream_bytes(&xlsm, "/VBA/ThisWorkbook");
        assert_eq!(&tw[..5], &[9, 9, 9, 9, 9]);

        // Project caches invalidated.
        assert_eq!(stream_bytes(&xlsm, "/VBA/_VBA_PROJECT"), vec![0xCC, 0x61, 0xFF, 0xFF, 0x00, 0x00, 0x00]);

        // A fresh pull reflects the new module set and the normalized sources.
        fs::remove_dir_all(&macros).unwrap();
        let again = pull_vba_modules(xlsm_s.clone()).unwrap();
        let names: Vec<&str> = again.modules.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["Module1", "ThisWorkbook", "Helpers", "NewClass"]);
        let helpers = fs::read_to_string(macros.join("Helpers.bas")).unwrap();
        assert!(helpers.starts_with("Attribute VB_Name = \"Helpers\"\r\nSub Help()"));
        let new_class = fs::read_to_string(macros.join("NewClass.cls")).unwrap();
        assert!(!new_class.contains("VERSION 1.0 CLASS"));
        assert!(new_class.contains("Attribute VB_Exposed = False"));
        let m1 = fs::read_to_string(macros.join("Module1.bas")).unwrap();
        assert!(m1.contains("Sub Hello(name As String)"));

        // PROJECT / PROJECTwm agree with the dir stream.
        let project = ProjectStream::parse(&stream_bytes(&xlsm, "/PROJECT"), 1252).unwrap();
        let kinds = project.module_kinds();
        assert!(kinds.iter().any(|(n, k)| n == "Helpers" && *k == ModuleKind::Standard));
        assert!(kinds.iter().any(|(n, k)| n == "NewClass" && *k == ModuleKind::Class));
        assert!(!kinds.iter().any(|(n, _)| n == "Class1"));
        let wm = ProjectWm::parse(&stream_bytes(&xlsm, "/PROJECTwm"), 1252).unwrap();
        assert_eq!(wm.names, vec!["Module1", "ThisWorkbook", "Helpers", "NewClass"]);
    }

    #[test]
    fn push_twice_reports_everything_unchanged() {
        let tmp = tempfile::tempdir().unwrap();
        let xlsm = three_module_workbook(tmp.path());
        let xlsm_s = xlsm.to_string_lossy().to_string();
        pull_vba_modules(xlsm_s.clone()).unwrap();
        let first = push_vba_modules_impl(&xlsm_s).unwrap();
        assert!(first.updated.is_empty());
        assert_eq!(first.unchanged.len(), 3);
        let second = push_vba_modules_impl(&xlsm_s).unwrap();
        assert!(second.updated.is_empty() && second.added.is_empty() && second.removed.is_empty());
    }

    #[test]
    fn push_matches_file_names_case_insensitively() {
        let tmp = tempfile::tempdir().unwrap();
        let xlsm = three_module_workbook(tmp.path());
        let xlsm_s = xlsm.to_string_lossy().to_string();
        let macros = PathBuf::from(pull_vba_modules(xlsm_s.clone()).unwrap().macros_dir);
        fs::rename(macros.join("Module1.bas"), macros.join("module1.bas")).unwrap();
        fs::write(macros.join("module1.bas"), "Attribute VB_Name = \"Module1\"\r\nSub Changed()\r\nEnd Sub\r\n").unwrap();
        let res = push_vba_modules_impl(&xlsm_s).unwrap();
        assert_eq!(res.updated, vec!["Module1"]);
        assert!(res.added.is_empty());
        assert!(res.removed.is_empty());
    }

    #[test]
    fn push_refuses_invalid_module_name_without_touching_workbook() {
        let tmp = tempfile::tempdir().unwrap();
        let xlsm = three_module_workbook(tmp.path());
        let xlsm_s = xlsm.to_string_lossy().to_string();
        let macros = PathBuf::from(pull_vba_modules(xlsm_s.clone()).unwrap().macros_dir);
        fs::write(macros.join("1bad.bas"), "Sub X()\r\nEnd Sub\r\n").unwrap();
        let original = fs::read(&xlsm).unwrap();
        let err = push_vba_modules_impl(&xlsm_s).unwrap_err();
        assert_eq!(err_code(&err), "invalid_module_name");
        assert_eq!(fs::read(&xlsm).unwrap(), original);
        assert!(!tmp.path().join("Book1.xlsm.bak").exists());
    }

    #[test]
    fn push_refuses_creating_thisworkbook_from_a_file() {
        // A workbook whose project has no ThisWorkbook module; a new file with
        // that name must not be added as a standard module.
        let tmp = tempfile::tempdir().unwrap();
        let bin = build_vba_bin(1252, &[std_module("Module1", "Attribute VB_Name = \"Module1\"\r\nSub A()\r\nEnd Sub\r\n")]);
        let xlsm = build_workbook(tmp.path(), "One.xlsm", &bin);
        let xlsm_s = xlsm.to_string_lossy().to_string();
        let macros = PathBuf::from(pull_vba_modules(xlsm_s.clone()).unwrap().macros_dir);
        fs::write(macros.join("ThisWorkbook.bas"), "Sub X()\r\nEnd Sub\r\n").unwrap();
        let err = push_vba_modules_impl(&xlsm_s).unwrap_err();
        assert_eq!(err_code(&err), "invalid_module_name");
        assert!(!tmp.path().join("One.xlsm.bak").exists());
    }

    #[test]
    fn push_treats_a_bas_file_for_a_document_module_as_an_update() {
        // The module's kind comes from the project, not the file extension.
        let tmp = tempfile::tempdir().unwrap();
        let xlsm = three_module_workbook(tmp.path());
        let xlsm_s = xlsm.to_string_lossy().to_string();
        let macros = PathBuf::from(pull_vba_modules(xlsm_s.clone()).unwrap().macros_dir);
        fs::remove_file(macros.join("ThisWorkbook.cls")).unwrap();
        fs::write(macros.join("ThisWorkbook.bas"), "Attribute VB_Name = \"ThisWorkbook\"\r\nPrivate Sub Workbook_Open()\r\nEnd Sub\r\n").unwrap();
        let res = push_vba_modules_impl(&xlsm_s).unwrap();
        assert_eq!(res.updated, vec!["ThisWorkbook"]);
        assert!(res.added.is_empty());
        assert!(res.skipped.is_empty());
    }

    #[test]
    fn push_refuses_duplicate_bas_and_cls() {
        let tmp = tempfile::tempdir().unwrap();
        let xlsm = three_module_workbook(tmp.path());
        let xlsm_s = xlsm.to_string_lossy().to_string();
        let macros = PathBuf::from(pull_vba_modules(xlsm_s.clone()).unwrap().macros_dir);
        fs::write(macros.join("Module1.cls"), "Sub X()\r\nEnd Sub\r\n").unwrap();
        let err = push_vba_modules_impl(&xlsm_s).unwrap_err();
        assert_eq!(err_code(&err), "duplicate_module_file");
    }

    #[test]
    fn push_reports_unencodable_characters() {
        let tmp = tempfile::tempdir().unwrap();
        let xlsm = three_module_workbook(tmp.path()); // code page 1252
        let xlsm_s = xlsm.to_string_lossy().to_string();
        let macros = PathBuf::from(pull_vba_modules(xlsm_s.clone()).unwrap().macros_dir);
        fs::write(macros.join("Module1.bas"), "Attribute VB_Name = \"Module1\"\r\nSub A()\r\n  MsgBox \"日本語\"\r\nEnd Sub\r\n").unwrap();
        let err = push_vba_modules_impl(&xlsm_s).unwrap_err();
        assert_eq!(err_code(&err), "unencodable_character");
        assert!(err.contains("Module1"));
        assert!(!tmp.path().join("Book1.xlsm.bak").exists());
    }

    #[test]
    fn push_requires_macros_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let xlsm = three_module_workbook(tmp.path());
        let err = push_vba_modules_impl(xlsm.to_str().unwrap()).unwrap_err();
        assert_eq!(err_code(&err), "macros_dir_not_found");
    }

    #[test]
    fn round_trip_works_in_a_japanese_folder_with_shift_jis_source() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("資料");
        fs::create_dir_all(&folder).unwrap();
        let bin = build_vba_bin(932, &[std_module("Module1", "Attribute VB_Name = \"Module1\"\r\nSub A()\r\n  MsgBox \"こんにちは\"\r\nEnd Sub\r\n")]);
        let xlsm = build_workbook(&folder, "帳票.xlsm", &bin);
        let xlsm_s = xlsm.to_string_lossy().to_string();
        let pulled = pull_vba_modules(xlsm_s.clone()).unwrap();
        assert_eq!(Path::new(&pulled.macros_dir), folder.join("帳票_assets").join("macros"));
        let src = fs::read_to_string(Path::new(&pulled.macros_dir).join("Module1.bas")).unwrap();
        assert!(src.contains("こんにちは"));
        fs::write(Path::new(&pulled.macros_dir).join("Module1.bas"), src.replace("こんにちは", "さようなら")).unwrap();
        let res = push_vba_modules_impl(&xlsm_s).unwrap();
        assert_eq!(res.updated, vec!["Module1"]);
        fs::remove_dir_all(&pulled.macros_dir).unwrap();
        pull_vba_modules(xlsm_s).unwrap();
        let src2 = fs::read_to_string(Path::new(&pulled.macros_dir).join("Module1.bas")).unwrap();
        assert!(src2.contains("さようなら"));
    }

    #[cfg(windows)]
    #[test]
    fn push_refuses_locked_workbook_before_backup() {
        use std::os::windows::fs::OpenOptionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let xlsm = three_module_workbook(tmp.path());
        let xlsm_s = xlsm.to_string_lossy().to_string();
        pull_vba_modules(xlsm_s.clone()).unwrap();
        let _holder = fs::OpenOptions::new().read(true).share_mode(0).open(&xlsm).unwrap();
        let err = push_vba_modules_impl(&xlsm_s).unwrap_err();
        assert_eq!(err_code(&err), "workbook_locked");
        assert!(!tmp.path().join("Book1.xlsm.bak").exists());
    }
```

- [ ] **Step 2: 失敗を確認**

Run: `cd src-tauri && cargo test vba::tests::push`
Expected: コンパイルエラー(`push_vba_modules_impl` 未定義)

- [ ] **Step 3: 実装**

`vba.rs` に(`inject_vba_modules` を削除して置き換え):

```rust
use crate::commands::vba_source::{normalize_source, validate_module_name};
use crate::commands::vba_streams::{DirStream, ModuleKind, ProjectStream, ProjectWm, REC_MODULETYPE_PROCEDURAL};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkippedModule {
    pub name: String,
    pub reason: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub xlsm_path: String,
    pub backup_path: String,
    pub updated: Vec<String>,
    pub unchanged: Vec<String>,
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub skipped: Vec<SkippedModule>,
}

/// One existing module with its kind resolved from the PROJECT stream.
#[derive(Debug, Clone)]
pub(crate) struct ProjectModule {
    pub name: String,
    pub stream_name: String,
    pub kind: ModuleKind,
    pub text_offset: u32,
}

pub(crate) struct LoadedProject {
    pub comp: cfb::CompoundFile<Cursor<Vec<u8>>>,
    pub dir: DirStream,
    pub project: ProjectStream,
    pub wm: ProjectWm,
    pub code_page: u16,
    pub modules: Vec<ProjectModule>,
}

fn read_stream(comp: &mut cfb::CompoundFile<Cursor<Vec<u8>>>, path: &str) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    comp.open_stream(path)
        .map_err(|e| format!("Failed to open stream '{}': {}", path, e))?
        .read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read stream '{}': {}", path, e))?;
    Ok(buf)
}

fn write_stream(comp: &mut cfb::CompoundFile<Cursor<Vec<u8>>>, path: &str, data: &[u8]) -> Result<(), String> {
    comp.create_stream(path)
        .map_err(|e| format!("Failed to create stream '{}': {}", path, e))?
        .write_all(data)
        .map_err(|e| format!("Failed to write stream '{}': {}", path, e))
}

/// Kind fallback for modules the PROJECT stream does not list.
fn heuristic_kind(name: &str, type_id: u16) -> ModuleKind {
    if type_id == REC_MODULETYPE_PROCEDURAL {
        ModuleKind::Standard
    } else if name.eq_ignore_ascii_case("ThisWorkbook") || name.to_ascii_lowercase().starts_with("sheet") {
        ModuleKind::Document
    } else {
        ModuleKind::Class
    }
}

pub(crate) fn load_project(vba_bin: Vec<u8>) -> Result<LoadedProject, String> {
    let mut comp = cfb::CompoundFile::open(Cursor::new(vba_bin))
        .map_err(|e| format!("Failed to parse vbaProject.bin as OLE2: {}", e))?;
    let dir = DirStream::parse(&vba_decompress(&read_stream(&mut comp, "/VBA/dir")?)?)?;
    let code_page = dir.code_page();
    let project = match read_stream(&mut comp, "/PROJECT") {
        Ok(bytes) => ProjectStream::parse(&bytes, code_page)?,
        Err(_) => ProjectStream { lines: vec![] },
    };
    let wm = match read_stream(&mut comp, "/PROJECTwm") {
        Ok(bytes) => ProjectWm::parse(&bytes, code_page)?,
        Err(_) => ProjectWm { names: vec![] },
    };
    let kinds: HashMap<String, ModuleKind> = project
        .module_kinds()
        .into_iter()
        .map(|(n, k)| (n.to_ascii_lowercase(), k))
        .collect();
    let modules = dir
        .modules()
        .into_iter()
        .map(|m| ProjectModule {
            kind: kinds
                .get(&m.name.to_ascii_lowercase())
                .copied()
                .unwrap_or_else(|| heuristic_kind(&m.name, m.type_id)),
            name: m.name,
            stream_name: m.stream_name,
            text_offset: m.text_offset,
        })
        .collect();
    Ok(LoadedProject { comp, dir, project, wm, code_page, modules })
}

fn file_ext_for(kind: ModuleKind) -> &'static str {
    if kind == ModuleKind::Standard { "bas" } else { "cls" }
}

/// Decoded source of an existing module (cache prefix skipped).
fn module_source(loaded: &mut LoadedProject, m: &ProjectModule) -> Result<String, String> {
    let data = read_stream(&mut loaded.comp, &format!("/VBA/{}", m.stream_name))?;
    let off = m.text_offset as usize;
    if off > data.len() {
        return Err(format!("Module '{}': text_offset {} exceeds stream length {}", m.name, off, data.len()));
    }
    decode_bytes(&vba_decompress(&data[off..])?, loaded.code_page)
}

/// Encode with the project code page, reporting the first unencodable character.
fn encode_module(source: &str, module_name: &str, code_page: u16) -> Result<Vec<u8>, String> {
    encode_string(source, code_page).map_err(|_| {
        let (line_no, ch) = source
            .lines()
            .enumerate()
            .find_map(|(i, l)| {
                l.chars().find(|c| encode_string(&c.to_string(), code_page).is_err()).map(|c| (i + 1, c))
            })
            .unwrap_or((0, '?'));
        vba_error(
            "unencodable_character",
            format!("Module '{}' line {}: '{}' cannot be encoded in code page {}", module_name, line_no, ch, code_page),
        )
    })
}

pub fn push_vba_modules_impl(xlsm_path: &str) -> Result<PushResult, String> {
    let file_path = require_macro_workbook(xlsm_path)?;
    let macros_dir = macros_dir_for(file_path)?;
    if !macros_dir.is_dir() {
        return Err(vba_error("macros_dir_not_found", format!("Macros directory not found: {} (run vba_pull first)", macros_dir.display())));
    }
    if workbook_lock(file_path).locked {
        return Err(vba_error("workbook_locked", "The workbook is open in Excel. Close it there, then push again."));
    }

    // Collect .bas/.cls files, keyed by lower-cased name for case-insensitive matching.
    let mut files: HashMap<String, (String, ModuleKind, PathBuf)> = HashMap::new();
    for entry in fs::read_dir(&macros_dir).map_err(|e| vba_error("push_failed", e.to_string()))? {
        let path = entry.map_err(|e| vba_error("push_failed", e.to_string()))?.path();
        let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase());
        let kind = match ext.as_deref() {
            Some("bas") => ModuleKind::Standard,
            Some("cls") => ModuleKind::Class,
            _ => continue,
        };
        let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        if files.insert(name.to_ascii_lowercase(), (name.clone(), kind, path)).is_some() {
            return Err(vba_error("duplicate_module_file", format!("Both {}.bas and {}.cls exist; keep one", name, name)));
        }
    }

    let xlsm_data = fs::read(file_path).map_err(|e| vba_error("push_failed", e.to_string()))?;
    let vba_bin = read_vba_project_bin(xlsm_path).map_err(|e| vba_error("no_vba_project", e))?;
    let mut loaded = load_project(vba_bin).map_err(|e| vba_error("push_failed", e))?;
    let code_page = match fs::read_to_string(macros_dir.join(".codepage")) {
        Ok(s) => s.trim().parse::<u16>().unwrap_or(loaded.code_page),
        Err(_) => loaded.code_page,
    };

    // ---- plan (nothing written yet) ----
    let existing_names: Vec<String> = loaded.modules.iter().map(|m| m.name.clone()).collect();
    let mut updated: Vec<(ProjectModule, Vec<u8>)> = Vec::new();
    let mut unchanged = Vec::new();
    let mut added: Vec<(String, ModuleKind, Vec<u8>)> = Vec::new();
    let mut removed: Vec<ProjectModule> = Vec::new();
    let mut skipped = Vec::new();
    let mut matched_files: std::collections::HashSet<String> = std::collections::HashSet::new();

    for m in loaded.modules.clone() {
        match files.get(&m.name.to_ascii_lowercase()) {
            Some((_, _, path)) => {
                matched_files.insert(m.name.to_ascii_lowercase());
                if m.kind == ModuleKind::Form {
                    skipped.push(SkippedModule { name: m.name.clone(), reason: "UserForms are not updated by push".into() });
                    continue;
                }
                let raw = fs::read_to_string(path).map_err(|e| vba_error("push_failed", format!("{}: {}", path.display(), e)))?;
                let normalized = normalize_source(&raw, &m.name, m.kind);
                let current = module_source(&mut loaded, &m).map_err(|e| vba_error("push_failed", e))?;
                if current == normalized {
                    unchanged.push(m.name.clone());
                } else {
                    let encoded = encode_module(&normalized, &m.name, code_page)?;
                    updated.push((m, encoded));
                }
            }
            None => match m.kind {
                ModuleKind::Standard | ModuleKind::Class => removed.push(m),
                ModuleKind::Document => skipped.push(SkippedModule { name: m.name.clone(), reason: "document module file is missing; document modules are never removed".into() }),
                ModuleKind::Form => skipped.push(SkippedModule { name: m.name.clone(), reason: "UserForms are never removed by push".into() }),
            },
        }
    }

    let mut new_files: Vec<&(String, ModuleKind, PathBuf)> = files
        .iter()
        .filter(|(k, _)| !matched_files.contains(*k))
        .map(|(_, v)| v)
        .collect();
    new_files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut taken = existing_names.clone();
    for (name, kind, path) in new_files {
        if name.eq_ignore_ascii_case("ThisWorkbook")
            || loaded.modules.iter().any(|m| m.kind == ModuleKind::Form && m.name.eq_ignore_ascii_case(name))
        {
            return Err(vba_error("invalid_module_name", format!("'{}' is a document or form module and cannot be created from a file", name)));
        }
        validate_module_name(name, &taken).map_err(|msg| vba_error("invalid_module_name", msg))?;
        taken.push(name.clone());
        let raw = fs::read_to_string(path).map_err(|e| vba_error("push_failed", format!("{}: {}", path.display(), e)))?;
        let encoded = encode_module(&normalize_source(&raw, name, *kind), name, code_page)?;
        added.push((name.clone(), *kind, encoded));
    }

    // ---- write ----
    let backup_path = format!("{}.bak", xlsm_path);
    fs::copy(xlsm_path, &backup_path).map_err(|e| vba_error("push_failed", format!("Failed to create backup: {}", e)))?;

    let write_err = |e: String| vba_error("push_failed", format!("{} (the original is in {})", e, backup_path));

    for (m, encoded) in &updated {
        let path = format!("/VBA/{}", m.stream_name);
        let mut data = read_stream(&mut loaded.comp, &path).map_err(write_err)?;
        data.truncate(m.text_offset as usize);
        data.extend_from_slice(&vba_compress(encoded));
        write_stream(&mut loaded.comp, &path, &data).map_err(write_err)?;
    }
    for (name, kind, encoded) in &added {
        write_stream(&mut loaded.comp, &format!("/VBA/{}", name), &vba_compress(encoded)).map_err(write_err)?;
        loaded.dir.append_module(name, name, *kind, 0, loaded.code_page).map_err(write_err)?;
        loaded.project.add_module(name, *kind);
        loaded.wm.add(name);
    }
    for m in &removed {
        loaded.comp.remove_stream(&format!("/VBA/{}", m.stream_name)).map_err(|e| write_err(e.to_string()))?;
        loaded.dir.remove_module(&m.name);
        loaded.project.remove_module(&m.name);
        loaded.wm.remove(&m.name);
    }
    write_stream(&mut loaded.comp, "/VBA/dir", &vba_compress(&loaded.dir.serialize())).map_err(write_err)?;
    write_stream(&mut loaded.comp, "/PROJECT", &loaded.project.serialize(loaded.code_page).map_err(write_err)?).map_err(write_err)?;
    write_stream(&mut loaded.comp, "/PROJECTwm", &loaded.wm.serialize(loaded.code_page).map_err(write_err)?).map_err(write_err)?;

    // Invalidate compiled caches so Excel rebuilds from the sources we wrote
    // (MS-OVBA 2.3.4.1: _VBA_PROJECT must carry no PerformanceCache on write;
    // __SRP_* are undocumented caches readers must ignore).
    const VBA_PROJECT_HEADER: [u8; 7] = [0xCC, 0x61, 0xFF, 0xFF, 0x00, 0x00, 0x00];
    write_stream(&mut loaded.comp, "/VBA/_VBA_PROJECT", &VBA_PROJECT_HEADER).map_err(write_err)?;
    let srp: Vec<std::path::PathBuf> = loaded
        .comp
        .walk()
        .filter(|e| e.is_stream() && e.name().starts_with("__SRP_") && e.path().parent().map(|p| p.to_string_lossy() == "/VBA").unwrap_or(false))
        .map(|e| e.path().to_path_buf())
        .collect();
    for p in srp {
        loaded.comp.remove_stream(&p).map_err(|e| write_err(e.to_string()))?;
    }

    loaded.comp.flush().map_err(|e| write_err(e.to_string()))?;
    let new_bin = loaded.comp.into_inner().into_inner();
    let new_xlsm = replace_zip_entry(&xlsm_data, "xl/vbaProject.bin", &new_bin).map_err(write_err)?;
    fs::write(xlsm_path, &new_xlsm).map_err(|e| write_err(e.to_string()))?;

    Ok(PushResult {
        xlsm_path: xlsm_path.to_string(),
        backup_path,
        updated: updated.into_iter().map(|(m, _)| m.name).collect(),
        unchanged,
        added: added.into_iter().map(|(n, _, _)| n).collect(),
        removed: removed.into_iter().map(|m| m.name).collect(),
        skipped,
    })
}

#[tauri::command]
pub fn push_vba_modules(app: AppHandle, xlsm_path: String) -> Result<PushResult, String> {
    let result = push_vba_modules_impl(&xlsm_path)?;
    let _ = app.emit("vba-pushed", serde_json::json!({ "path": xlsm_path }));
    Ok(result)
}
```

`pull_vba_modules` と `list_vba_modules` も `load_project` を使うよう書き換え、種別は `m.kind.as_str()`、拡張子は `file_ext_for(m.kind)`、`ModuleKind::Form` は一覧・展開の対象外(skip)。`pull_vba_modules` の本文:

```rust
    let vba_bin = read_vba_project_bin(xlsm_path.as_str()).map_err(|e| vba_error("no_vba_project", e))?;
    let mut loaded = load_project(vba_bin).map_err(|e| vba_error("pull_failed", e))?;
    let editable: Vec<ProjectModule> = loaded.modules.iter().filter(|m| m.kind != ModuleKind::Form).cloned().collect();
    if editable.is_empty() {
        return Err(vba_error("no_vba_project", "No VBA modules found in this file"));
    }
    let macros_dir = macros_dir_for(file_path)?;
    fs::create_dir_all(&macros_dir).map_err(|e| vba_error("pull_failed", e.to_string()))?;
    fs::write(macros_dir.join(".codepage"), loaded.code_page.to_string()).map_err(|e| vba_error("pull_failed", e.to_string()))?;
    let mut modules = Vec::new();
    for m in &editable {
        let source = fix_vb_name(&module_source(&mut loaded, m).map_err(|e| vba_error("pull_failed", e))?, &m.name);
        let module_path = macros_dir.join(format!("{}.{}", m.name, file_ext_for(m.kind)));
        fs::write(&module_path, &source).map_err(|e| vba_error("pull_failed", e.to_string()))?;
        modules.push(VbaModule { name: m.name.clone(), module_type: m.kind.as_str().to_string(), path: Some(module_path.to_string_lossy().into_owned()) });
    }
```

(`read_vba_project_bin` のエラー文言は既存のまま。`get_code_page_from_xlsm` は不要になるので削除。)

`lib.rs`: `commands::vba::inject_vba_modules` → `commands::vba::push_vba_modules`。

- [ ] **Step 4: テスト実行**

Run: `cd src-tauri && cargo test vba`
Expected: 新テスト 10 件(Windows では 11 件)を含め全 PASS

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/commands/vba.rs src-tauri/src/lib.rs
git commit -m "feat(vba): push with module add/remove, kinds from PROJECT stream, synthetic round-trip tests"
```

### Task 6: HTTP ブリッジの整理と `active_xlsm` の削除

**Files:**
- Modify: `src-tauri/src/http_bridge.rs`(`XlsmRequest` / `InjectRequest` 137-145 行、`check_active_tab` 226-258 行、`/active-xlsm` `/vba/list` `/vba/extract` `/vba/inject` 320-458 行)
- Delete: `src-tauri/src/commands/active_xlsm.rs`(`get_http_bridge_info` と `HttpBridgeClientInfo` は `http_bridge.rs` に移す)
- Modify: `src-tauri/src/commands/mod.rs`(`pub mod active_xlsm;` を削除)、`src-tauri/src/lib.rs`(`ActiveXlsmState` の `manage`、`use`、コマンド登録 3 行を削除し `http_bridge::get_http_bridge_info` を追加)
- Test: `http_bridge.rs` の `mod tests`

**Interfaces:**
- Consumes: Task 1/5 の `list_vba_modules`、`pull_vba_modules`、`push_vba_modules_impl`、`vba_error`
- Produces: `POST /vba/list|pull|push` `{xlsm_path}`、成功時 200 とコマンドの戻り値、失敗時 `{error, message}` を `status_for_vba_error(code)` の状態で返す(`workbook_locked` → 409、`*_failed` → 500、他 → 400)。push 成功時 `vba-pushed` を emit。`pub fn resolve_xlsm_path(raw: &str, active_folder: Option<&str>) -> Result<String, String>`、`#[tauri::command] get_http_bridge_info`

- [ ] **Step 1: 失敗するテストを書く**

`http_bridge.rs` の末尾に:

```rust
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
}
```

- [ ] **Step 2: 失敗を確認**

Run: `cd src-tauri && cargo test http_bridge`
Expected: コンパイルエラー

- [ ] **Step 3: 実装**

`http_bridge.rs`:

```rust
// remove: use crate::commands::active_xlsm::ActiveXlsmState;
// remove: struct InjectRequest, fn check_active_tab

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
```

`handle_request` の `match url.as_str()` から `/active-xlsm` `/vba/list` `/vba/extract` `/vba/inject` の腕を削除し、代わりに:

```rust
        "/vba/list" | "/vba/pull" | "/vba/push" => {
            let route = url.trim_start_matches("/vba/");
            let (status, body) = handle_vba_route(app, route, &body_str);
            let _ = request.respond(json_response(status, body));
        }
```

`lib.rs`: `.manage::<ActiveXlsmState>(...)` と `use commands::active_xlsm::...` を削除。コマンド登録を:

```rust
            // VBA macro operations
            commands::vba::pull_vba_modules,
            commands::vba::push_vba_modules,
            commands::vba::list_vba_modules,
            commands::vba::check_workbook_lock,
            http_bridge::get_http_bridge_info,
```

`active_xlsm.rs` を削除し、`mod.rs` から外す。

- [ ] **Step 4: テスト実行**

Run: `cd src-tauri && cargo test http_bridge && cargo test vba && cargo build`
Expected: PASS、ビルド成功(警告なし)

- [ ] **Step 5: コミット**

```bash
git add -A src-tauri/src
git commit -m "feat(vba): path-based /vba/list|pull|push bridge routes, drop active-tab state"
```

---

## Part B: opencode ツール・スキル・既存 UI の整理

### Task 7: カスタムツール 3 本と版マーカー付き自動インストール

**Files:**
- Create: `.opencode/tools/vba_list.ts`、`.opencode/tools/vba_pull.ts`、`.opencode/tools/vba_push.ts`
- Create: `src/features/opencode-config/lib/builtin-install.ts`
- Modify: `src/features/opencode-config/lib/builtin-registry.ts`(`BUILTIN_CUSTOM_TOOLS` 99-118 行)
- Modify: `.opencode/tools/rag_search.ts`、`folder_glob.ts`、`folder_grep.ts`(1 行目にマーカー)
- Modify: `src/features/opencode-config/hooks/useOpencodeChat.ts`(`ensureBuiltinAgents` 1056-1107 行 → `ensureBuiltinFiles`)
- Test: `src/features/opencode-config/lib/__tests__/builtin-install.test.ts`

**Interfaces:**
- Produces(`builtin-install.ts`):
  - `export const TOOL_VERSION_RE = /mdium-tool-version:\s*(\d+)/;`
  - `export const SKILL_VERSION_RE = /mdium-skill-version:\s*(\d+)/;`
  - `export function builtinVersion(content: string, re: RegExp): string | null`
  - `export function shouldWriteBuiltinFile(existing: string | null, wanted: string, re: RegExp): boolean`
  - `export function buildSkillMd(name: string, description: string, body: string, version?: number): string`
- ツール: `vba_list({ xlsm_path })`、`vba_pull({ xlsm_path })`、`vba_push({ xlsm_path })`

- [ ] **Step 1: 失敗するテストを書く**

`src/features/opencode-config/lib/__tests__/builtin-install.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  SKILL_VERSION_RE,
  TOOL_VERSION_RE,
  buildSkillMd,
  builtinVersion,
  shouldWriteBuiltinFile,
} from "../builtin-install";

describe("builtinVersion", () => {
  it("reads the tool marker from the first line", () => {
    expect(builtinVersion("// mdium-tool-version: 3\nimport x", TOOL_VERSION_RE)).toBe("3");
  });
  it("reads the skill marker from frontmatter", () => {
    expect(builtinVersion("---\nname: s\nmdium-skill-version: 2\n---\n", SKILL_VERSION_RE)).toBe("2");
  });
  it("returns null without a marker", () => {
    expect(builtinVersion("import x", TOOL_VERSION_RE)).toBeNull();
  });
});

describe("shouldWriteBuiltinFile", () => {
  it("writes when the file is missing", () => {
    expect(shouldWriteBuiltinFile(null, "1", TOOL_VERSION_RE)).toBe(true);
  });
  it("overwrites an older builtin version", () => {
    expect(shouldWriteBuiltinFile("// mdium-tool-version: 1\n", "2", TOOL_VERSION_RE)).toBe(true);
  });
  it("leaves the current version alone", () => {
    expect(shouldWriteBuiltinFile("// mdium-tool-version: 2\n", "2", TOOL_VERSION_RE)).toBe(false);
  });
  it("never touches a file without a marker (user-authored)", () => {
    expect(shouldWriteBuiltinFile("export default tool({})", "2", TOOL_VERSION_RE)).toBe(false);
  });
});

describe("buildSkillMd", () => {
  it("emits frontmatter with the version marker", () => {
    const md = buildSkillMd("vba-mdium-flow", "desc", "# Body", 3);
    expect(md).toBe("---\nname: vba-mdium-flow\ndescription: desc\nmdium-skill-version: 3\n---\n\n# Body");
  });
  it("omits description and version when absent", () => {
    expect(buildSkillMd("s", "", "B")).toBe("---\nname: s\n---\n\nB");
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test -- src/features/opencode-config/lib/__tests__/builtin-install.test.ts`
Expected: FAIL(モジュール未定義)

- [ ] **Step 3: 実装**

`src/features/opencode-config/lib/builtin-install.ts`:

```ts
/**
 * Version markers let mdium update the builtin tool/skill files it installed
 * without clobbering files the user wrote or edited by hand (no marker).
 */
export const TOOL_VERSION_RE = /mdium-tool-version:\s*(\d+)/;
export const SKILL_VERSION_RE = /mdium-skill-version:\s*(\d+)/;

export function builtinVersion(content: string, re: RegExp): string | null {
  return content.match(re)?.[1] ?? null;
}

export function shouldWriteBuiltinFile(
  existing: string | null,
  wanted: string,
  re: RegExp,
): boolean {
  if (existing === null) return true;
  const current = builtinVersion(existing, re);
  if (current === null) return false;
  return current !== wanted;
}

/** SKILL.md with frontmatter (name, optional description, optional version). */
export function buildSkillMd(
  name: string,
  description: string,
  body: string,
  version?: number,
): string {
  const lines = ["---", `name: ${name}`];
  if (description) lines.push(`description: ${description}`);
  if (version !== undefined) lines.push(`mdium-skill-version: ${version}`);
  lines.push("---", "");
  if (body) lines.push(body);
  return lines.join("\n");
}
```

`.opencode/tools/vba_list.ts`(`vba_pull.ts` / `vba_push.ts` は `ROUTE`・`description` だけ違う。各ファイルは単独で動く必要があるので共通部を複製する):

```ts
// mdium-tool-version: 1
// .opencode/tools/vba_list.ts
//
// Lists the VBA modules of an .xlsm/.xlam workbook by asking the running mdium
// app over its local HTTP bridge. Read-only.
import { tool } from "@opencode-ai/plugin";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

const ROUTE = "list";

async function readBridgeInfo(): Promise<{ port: number; token: string } | null> {
  const path = join(homedir(), ".config", "opencode", ".mdium-bridge.json");
  try {
    const info = JSON.parse(await readFile(path, "utf-8"));
    if (typeof info?.port === "number" && typeof info?.token === "string") return info;
    return null;
  } catch {
    return null;
  }
}

async function callVbaBridge(xlsmPath: string): Promise<string> {
  const bridge = await readBridgeInfo();
  if (!bridge) {
    return "Cannot reach mdium (no active connection). Open the mdium app and connect opencode for this folder.";
  }
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${bridge.port}/vba/${ROUTE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ xlsm_path: xlsmPath }),
    });
  } catch (e: any) {
    return `Failed to reach mdium: ${e?.message ?? e}.`;
  }
  let data: any;
  try {
    data = await res.json();
  } catch {
    return `mdium returned a non-JSON response (HTTP ${res.status}).`;
  }
  if (!res.ok) {
    return `vba_${ROUTE} failed (${data?.error ?? `HTTP ${res.status}`}): ${data?.message ?? ""}`.trim();
  }
  return JSON.stringify(data, null, 2);
}

export default tool({
  description:
    "List the VBA modules of an .xlsm/.xlam workbook (name, moduleType standard|class|document, " +
    "extracted file path if any), whether its macros folder <stem>_assets/macros/ exists, and " +
    "whether the workbook is currently locked by Excel. Read-only.",
  args: {
    xlsm_path: tool.schema
      .string()
      .describe("Absolute path of the .xlsm/.xlam workbook (from <mdium_context> active_file or the user)."),
  },
  async execute(args) {
    return callVbaBridge(args.xlsm_path);
  },
});
```

`vba_pull.ts` の `description`:
「Extract every VBA module of the workbook into <stem>_assets/macros/ as .bas (standard) and .cls (class/document) files, overwriting existing files there. Call before editing when the folder does not exist yet or the workbook is newer than the files.」

`vba_push.ts` の `description`:
「Write the .bas/.cls files in <stem>_assets/macros/ back into the workbook: changed files update their module, new files add standard (.bas) or class (.cls) modules, and missing files remove standard/class modules. Document modules (ThisWorkbook, sheets) are never removed. Makes a <workbook>.bak first. Refuses with workbook_locked while Excel has the file open.」

`rag_search.ts` / `folder_glob.ts` / `folder_grep.ts` の 1 行目に `// mdium-tool-version: 1` を追加。

`builtin-registry.ts`: `?raw` import を 3 つ追加し `BUILTIN_CUSTOM_TOOLS` に:

```ts
import vbaListToolSrc from "../../../../.opencode/tools/vba_list.ts?raw";
import vbaPullToolSrc from "../../../../.opencode/tools/vba_pull.ts?raw";
import vbaPushToolSrc from "../../../../.opencode/tools/vba_push.ts?raw";
// ...
  vba_list: {
    description: "List the VBA modules of an .xlsm/.xlam workbook via mdium. Pairs with the vba-mdium-flow skill.",
    fileName: "vba_list.ts",
    content: vbaListToolSrc,
  },
  vba_pull: {
    description: "Extract VBA modules of a workbook into <stem>_assets/macros/ via mdium.",
    fileName: "vba_pull.ts",
    content: vbaPullToolSrc,
  },
  vba_push: {
    description: "Write edited .bas/.cls files back into the workbook (add/remove supported) via mdium.",
    fileName: "vba_push.ts",
    content: vbaPushToolSrc,
  },
```

`useOpencodeChat.ts`: `ensureBuiltinAgents` を `ensureBuiltinFiles` に改名し、ツールのループを全 `BUILTIN_CUSTOM_TOOLS` 対象・版判定にする(エージェントのループは現状維持):

```ts
import { TOOL_VERSION_RE, builtinVersion, shouldWriteBuiltinFile } from "../lib/builtin-install";

// ─── Auto-install builtin tools, skills and agents ───
async function ensureBuiltinFiles(): Promise<void> {
  const home = await invoke<string>("get_home_dir");
  const sep = home.includes("\\") ? "\\" : "/";
  const configDir = `${home}${sep}.config${sep}opencode`;
  const toolsDir = `${configDir}${sep}tools`;

  // Builtin tools carry a `mdium-tool-version` marker; files without one are
  // user-authored and never touched.
  for (const entry of Object.values(BUILTIN_CUSTOM_TOOLS)) {
    const toolPath = `${toolsDir}${sep}${entry.fileName}`;
    const wanted = builtinVersion(entry.content, TOOL_VERSION_RE) ?? "0";
    const existing = await invoke<string>("read_text_file", { path: toolPath }).catch(() => null);
    if (!shouldWriteBuiltinFile(existing, wanted, TOOL_VERSION_RE)) continue;
    try {
      await invoke("write_tool_file", { baseDir: toolsDir, fileName: entry.fileName, content: entry.content });
      console.log(`[opencode] installed builtin tool: ${toolPath}`);
    } catch (e) {
      console.warn(`[opencode] failed to install tool ${entry.fileName}:`, e);
    }
  }

  // (existing BUILTIN_AGENTS loop unchanged)
}
```

`doConnect` 内の呼び出しを `await ensureBuiltinFiles();` に変更。

- [ ] **Step 4: テスト実行**

Run: `npm test -- src/features/opencode-config/lib/__tests__/builtin-install.test.ts && npx tsc --noEmit`
Expected: 9 件 PASS、型エラーなし

- [ ] **Step 5: コミット**

```bash
git add .opencode/tools src/features/opencode-config/lib/builtin-install.ts src/features/opencode-config/lib/__tests__/builtin-install.test.ts src/features/opencode-config/lib/builtin-registry.ts src/features/opencode-config/hooks/useOpencodeChat.ts
git commit -m "feat(opencode): vba_list/vba_pull/vba_push custom tools with versioned auto-install"
```

### Task 8: スキルの書き直しと自動導入

**Files:**
- Modify: `src/shared/types/index.ts`(`BuiltinSkill` 219-223 行に `version: number`)
- Modify: `src/features/opencode-config/lib/builtin-skills.ts`(`vba-coding-conventions` に `version: 1`、`vba-mdium-flow` 211-246 行を書き直し `version: 2`)
- Modify: `src/features/opencode-config/hooks/useOpencodeChat.ts`(`ensureBuiltinFiles` にスキル導入を追加)
- Modify: `src/features/opencode-config/components/sections/SkillsSection.tsx`(ローカル `buildSkillMd` 35-41 行を削除し `builtin-install` のものを使う。`handleAddBuiltin` で `SRC_SKILLS[name].version` を渡す)
- Modify: `docs/builtin-skills.ja.md`(`vba-mdium-flow` 節 216 行以降)
- Test: `src/features/opencode-config/lib/__tests__/builtin-skills.test.ts`

**Interfaces:**
- Consumes: Task 7 の `buildSkillMd`、`SKILL_VERSION_RE`、`shouldWriteBuiltinFile`
- Produces: `BUILTIN_SKILLS[name].version`、`~/.config/opencode/skills/<name>/SKILL.md` の自動導入

- [ ] **Step 1: 失敗するテストを書く**

`src/features/opencode-config/lib/__tests__/builtin-skills.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BUILTIN_SKILLS } from "../builtin-skills";

describe("builtin skills", () => {
  it("every builtin skill has a positive integer version", () => {
    for (const [name, skill] of Object.entries(BUILTIN_SKILLS)) {
      expect(Number.isInteger(skill.version), name).toBe(true);
      expect(skill.version, name).toBeGreaterThan(0);
    }
  });

  it("vba-mdium-flow teaches the path-based tools and the lock rule", () => {
    const body = BUILTIN_SKILLS["vba-mdium-flow"].content;
    for (const needle of ["vba_list", "vba_pull", "vba_push", "active_file", "workbook_locked", "VERSION 1.0 CLASS", "ThisWorkbook"]) {
      expect(body).toContain(needle);
    }
    expect(body).not.toContain("mdium-vba");
    expect(body).not.toContain("active_tab_changed");
    expect(body).not.toContain("import_vba_macros");
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test -- src/features/opencode-config/lib/__tests__/builtin-skills.test.ts`
Expected: FAIL(`version` 未定義、旧文言)

- [ ] **Step 3: 実装**

`BuiltinSkill` に `/** Bumped whenever content changes so auto-install overwrites older copies. */ version: number;` を追加。`vba-coding-conventions` に `version: 1,`。

`vba-mdium-flow` を置き換える:

```ts
  "vba-mdium-flow": {
    name: "vba-mdium-flow",
    version: 2,
    description:
      "Use when editing VBA macros of an .xlsm/.xlam workbook opened in MDium — pull the modules with vba_pull, edit the .bas/.cls files, write them back with vba_push, and report the result.",
    content: `# MDium Macro Editing Flow

MDium exposes three tools that operate on a workbook path: \`vba_list\`, \`vba_pull\`, \`vba_push\`.
Also read the \`vba-coding-conventions\` skill before writing VBA.

## Which workbook

1. Use the \`active_file\` from the \`<mdium_context>\` block at the top of the latest user message. MDium adds it whenever the user is looking at an .xlsm/.xlam, so the user never has to type a path.
2. If there is no \`<mdium_context>\`, use a path the user wrote.
3. If neither exists, ask the user which workbook to edit. Do not guess.

Pass that path as \`xlsm_path\` to every tool call.

## Standard flow

1. \`vba_list\` — see the modules, whether \`<stem>_assets/macros/\` is already extracted, and whether the workbook is locked.
2. If \`extracted\` is false, call \`vba_pull\`. If it is true, the folder may hold edits from an earlier session; ask the user before overwriting it with \`vba_pull\` when the workbook might be newer.
3. Edit the \`.bas\` / \`.cls\` files in the macros folder with Read / Edit.
4. **When editing is done, you MUST call \`vba_push\`.** Nothing reaches the workbook until then.
5. Report \`updated\`, \`added\`, \`removed\`, \`skipped\` and \`backupPath\` to the user, and ask them to verify in Excel. MDium does not run macros.

## Workbook locked by Excel

- \`vba_list\` returns \`locked: true\` and \`vba_push\` fails with \`workbook_locked\` while Excel has the file open.
- You may still pull and edit. Tell the user to close the workbook in Excel, wait for them to confirm, then call \`vba_push\` again.

## Adding and removing modules

- New standard module: create \`<Name>.bas\`. New class module: create \`<Name>.cls\`. \`vba_push\` adds them.
- Remove a standard or class module by deleting its file — but only when the user explicitly asked for the removal. \`vba_push\` reports it under \`removed\`.
- Never delete \`ThisWorkbook.cls\` or sheet \`.cls\` files. Document modules are never removed; a missing file is reported under \`skipped\` and the module keeps its old code.
- Module names: start with a letter, ASCII letters/digits/underscore only, at most 31 characters, unique ignoring case, not a VBA keyword. \`vba_push\` rejects the whole push (\`invalid_module_name\`) otherwise.

## File format rules

- Files are UTF-8. Keep \`Attribute VB_Name = "<file name without extension>"\` as the first line.
- Do not write a \`VERSION 1.0 CLASS\` / \`BEGIN\` / \`END\` header in \`.cls\` files; MDium strips it on push.
- If \`vba_push\` fails with \`unencodable_character\`, the workbook's code page cannot store that character. Replace it (for example with an ASCII equivalent or \`ChrW\`) and push again.

## Recovery

\`vba_push\` writes \`<workbook>.bak\` before changing the workbook. If the user reports a broken workbook, tell them to close Excel, delete the workbook, and rename the \`.bak\` back.
`,
  },
```

`ensureBuiltinFiles` にスキル導入を追加(ツールのループの後):

```ts
import { SKILL_VERSION_RE, buildSkillMd } from "../lib/builtin-install";
import { BUILTIN_SKILLS } from "../lib/builtin-skills";

  // Builtin skills: same marker rule, and a user-disabled skill
  // (SKILL.md.disabled) is left alone entirely.
  for (const skill of Object.values(BUILTIN_SKILLS)) {
    const skillPath = `${configDir}${sep}skills${sep}${skill.name}${sep}SKILL.md`;
    const disabled = await invoke<string>("read_text_file", { path: `${skillPath}.disabled` }).catch(() => null);
    if (disabled !== null) continue;
    const existing = await invoke<string>("read_text_file", { path: skillPath }).catch(() => null);
    if (!shouldWriteBuiltinFile(existing, String(skill.version), SKILL_VERSION_RE)) continue;
    try {
      await invoke("write_skill", {
        baseDir: configDir,
        dirName: skill.name,
        content: buildSkillMd(skill.name, skill.description, skill.content, skill.version),
      });
      console.log(`[opencode] installed builtin skill: ${skillPath}`);
    } catch (e) {
      console.warn(`[opencode] failed to install skill ${skill.name}:`, e);
    }
  }
```

`SkillsSection.tsx`: ローカル `buildSkillMd` を削除し `import { buildSkillMd } from "../../lib/builtin-install"; import { BUILTIN_SKILLS as SRC_SKILLS } from "../../lib/builtin-skills";` を追加。`handleAddBuiltin` を:

```ts
    const md = buildSkillMd(name, entry.description ?? "", entry.content, SRC_SKILLS[name]?.version);
```

`docs/builtin-skills.ja.md` の `## vba-mdium-flow` 節を上のスキル内容の日本語要約に置き換える(説明文、対象ブックの決め方、標準フロー、ロック時、追加・削除、ファイル形式、復元の 6 小節)。

- [ ] **Step 4: テスト実行**

Run: `npm test -- src/features/opencode-config && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/shared/types/index.ts src/features/opencode-config docs/builtin-skills.ja.md
git commit -m "feat(opencode): rewrite vba-mdium-flow for path tools and auto-install builtin skills"
```

### Task 9: 旧 MCP 経路・トグルの削除と PreviewPanel の pull/push 化

**Files:**
- Create: `src/features/opencode-config/lib/mdium-context.ts`
- Modify: `src/features/opencode-config/hooks/useOpencodeChat.ts`(`wrapWithMdiumContext` 96-110 行、`syncMdiumVbaMcpConfig` 118-187 行と 1168-1171 行の呼び出し、`resolveMdiumVbaMcpServer` import、`doLoadSession` を `export`)
- Modify: `src/features/opencode-config/lib/builtin-mcp-servers.ts`(`mdium-vba` 項目と `resolveMdiumVbaMcpServer` を削除)
- Delete: `resources/mcp-servers/mdium-vba/`
- Modify: `src/stores/settings-store.ts`(`allowLlmVbaImport` / `setAllowLlmVbaImport` を削除、`partialize` からも)
- Modify: `src/features/preview/components/PreviewPanel.tsx`(import 32 行、state 241-242 行、`set_active_xlsm_path` effect 1138-1148 行、`handleExportMacros` / `handleImportMacros` 1184-1256 行、トグル 1306-1333 行)
- Modify: `src/features/preview/components/PreviewPanel.css`(`.preview-panel__llm-toggle*` / `.preview-panel__switch*` 726 行以降を削除)
- Modify: `src/shared/i18n/locales/ja/editor.json`、`en/editor.json`
- Modify: `README.md` 88 行、`README.ja.md` 88 行
- Delete: `src/features/preview/components/PreviewPanel.test.tsx` の `PreviewPanel VBA import switch` describe(ファイルごと置き換え)
- Test: `src/features/opencode-config/lib/__tests__/mdium-context.test.ts`、`src/features/preview/components/PreviewPanel.test.tsx`

**Interfaces:**
- Produces: `export function wrapWithMdiumContext(text: string, activeFilePath: string | null | undefined): string`(純関数)、`export async function doLoadSession(sessionId: string)`、i18n キー `macroPushSuccess`、`workbookLocked`

- [ ] **Step 1: 失敗するテストを書く**

`src/features/opencode-config/lib/__tests__/mdium-context.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { wrapWithMdiumContext } from "../mdium-context";

describe("wrapWithMdiumContext", () => {
  it("prefixes the active xlsm path", () => {
    expect(wrapWithMdiumContext("hi", "C:/w/Book.xlsm")).toBe(
      '<mdium_context>\nactive_file="C:/w/Book.xlsm"\n</mdium_context>\n\nhi',
    );
  });
  it("accepts .xlam regardless of case", () => {
    expect(wrapWithMdiumContext("hi", "C:/w/ADDIN.XLAM")).toContain("<mdium_context>");
  });
  it("leaves non-macro files and missing paths untouched", () => {
    expect(wrapWithMdiumContext("hi", "C:/w/notes.md")).toBe("hi");
    expect(wrapWithMdiumContext("hi", null)).toBe("hi");
    expect(wrapWithMdiumContext("hi", undefined)).toBe("hi");
  });
  it("escapes double quotes in the path", () => {
    expect(wrapWithMdiumContext("hi", 'C:/w/a"b.xlsm')).toContain('active_file="C:/w/a\\"b.xlsm"');
  });
});
```

`PreviewPanel.test.tsx` を次で置き換える:

```tsx
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewPanel } from "./PreviewPanel";
import { useTabStore, type Tab } from "@/stores/tab-store";
import { useUiStore } from "@/stores/ui-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn(), exists: vi.fn().mockResolvedValue(true) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("./OfficePreview", () => ({ OfficePreview: () => null }));
vi.mock("./MacroChatPane", () => ({ MacroChatPane: () => <div data-testid="macro-chat" /> }));

const tab: Tab = {
  id: "xlsm-tab",
  filePath: "C:/project/book.xlsm",
  folderPath: "C:/project",
  fileName: "book.xlsm",
  content: "",
  dirty: false,
  undoStack: [],
  redoStack: [],
  binaryData: new Uint8Array([1]),
  officeFileType: ".xlsm",
};

describe("PreviewPanel macro buttons", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_workbook_lock") return { locked: false, reason: null };
      if (cmd === "push_vba_modules") return { xlsmPath: tab.filePath, backupPath: "b", updated: ["Module1"], unchanged: [], added: ["Helpers"], removed: [], skipped: [] };
      if (cmd === "read_binary_file") return [1];
      return null;
    });
    useTabStore.setState({ tabs: [tab], activeTabId: tab.id, activeFolderPath: tab.folderPath });
    useUiStore.setState({ activeViewTab: "preview" });
  });

  afterEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null, activeFolderPath: null });
  });

  it("shows no LLM toggle and pushes with the workbook path only", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<PreviewPanel previewRef={{ current: null }} />));
    expect(container.querySelector('[role="switch"]')).toBeNull();

    const buttons = [...container.querySelectorAll(".preview-panel__convert-bar button")];
    const importBtn = buttons.find((b) => b.textContent?.includes("取り込み") || b.textContent?.includes("Load"))!;
    expect(importBtn).toBeDefined();
    await act(async () => {
      (importBtn as HTMLButtonElement).click();
      // Let the awaited invoke chain inside the handler settle.
      await new Promise((r) => setTimeout(r, 0));
    });

    const pushCall = invoke.mock.calls.find((c) => c[0] === "push_vba_modules")!;
    expect(pushCall[1]).toEqual({ xlsmPath: tab.filePath });
    expect(container.querySelector(".preview-panel__convert-success")?.textContent).toContain("1");
    await act(async () => root.unmount());
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test -- src/features/opencode-config/lib/__tests__/mdium-context.test.ts src/features/preview/components/PreviewPanel.test.tsx`
Expected: FAIL(モジュール未定義、スイッチが存在)

- [ ] **Step 3: 実装**

`src/features/opencode-config/lib/mdium-context.ts`:

```ts
const MACRO_EXTENSIONS = [".xlsm", ".xlam"];

export function isMacroWorkbookPath(path: string | null | undefined): path is string {
  if (!path) return false;
  const lower = path.toLowerCase();
  return MACRO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Prefix a user message with the workbook the user is looking at so the LLM
 * can pass it to vba_list / vba_pull / vba_push without asking for a path.
 */
export function wrapWithMdiumContext(text: string, activeFilePath: string | null | undefined): string {
  if (!isMacroWorkbookPath(activeFilePath)) return text;
  const escaped = activeFilePath.replace(/"/g, '\\"');
  return `<mdium_context>\nactive_file="${escaped}"\n</mdium_context>\n\n${text}`;
}
```

`useOpencodeChat.ts`:
- `wrapWithMdiumContext` の非同期版(96-110 行)を削除し、`doSendMessage` の該当行を
  `const wrappedText = applyForward(wrapWithMdiumContext(text, useTabStore.getState().getActiveTab()?.filePath), replacementSettings());`
  に変更(`import { wrapWithMdiumContext } from "../lib/mdium-context";`)
- `syncMdiumVbaMcpConfig` 関数と 1168-1171 行の呼び出し、`resolveMdiumVbaMcpServer` の import、未使用になる `OpencodeMcpServer` の import を削除
- `async function doLoadSession` を `export async function doLoadSession` に

`builtin-mcp-servers.ts`: `"mdium-vba": {...}` の項目と `resolveMdiumVbaMcpServer` を削除(`invoke` の import が未使用になれば削除)。

`resources/mcp-servers/mdium-vba/` を `git rm -r` で削除。

`settings-store.ts`: `allowLlmVbaImport: boolean;`、`setAllowLlmVbaImport`、初期値、setter、`partialize` の行を削除。

`PreviewPanel.tsx`:
- import 32 行から `syncMdiumVbaMcpConfig` を外し、`import { listen } from "@tauri-apps/api/event";` を追加
- `allowLlmVbaImport` / `setAllowLlmVbaImport` の 2 行、`set_active_xlsm_path` の effect、トグルの JSX、`macroModuleSetChanged` の分岐を削除
- `macrosDirExists` の計算は残す(`_assets/macros` は既に正しい)
- `handleExportMacros` の invoke を `pull_vba_modules` に、`handleImportMacros` を:

```tsx
  const reloadWorkbookTab = useCallback(async (path: string) => {
    const bytes = await invoke<number[]>("read_binary_file", { path });
    const binaryData = new Uint8Array(bytes);
    const { tabs } = useTabStore.getState();
    useTabStore.setState({
      tabs: tabs.map((tab) => (tab.filePath === path ? { ...tab, binaryData } : tab)),
    });
    onRefreshFileTree?.();
  }, [onRefreshFileTree]);

  const handleImportMacros = useCallback(async () => {
    if (!activeTab?.filePath) return;
    setMacroImporting(true);
    setMacroError(null);
    setMacroSuccess(null);
    try {
      const filePath = activeTab.filePath;
      const result = await invoke<{ updated: string[]; added: string[]; removed: string[] }>(
        "push_vba_modules",
        { xlsmPath: filePath },
      );
      setMacroSuccess(
        t("macroPushSuccess", { updated: result.updated.length, added: result.added.length, removed: result.removed.length }),
      );
      await reloadWorkbookTab(filePath);
      const shouldOpen = await showConfirm(t("macroImportOpenFile"));
      if (shouldOpen) {
        await invoke("open_in_default_app", { path: filePath });
      }
    } catch (e) {
      setMacroError(vbaErrorMessage(e));
    } finally {
      setMacroImporting(false);
    }
  }, [activeTab?.filePath, reloadWorkbookTab, t]);
```

共通のエラー整形(ファイル先頭、コンポーネント外):

```ts
/** Rust vba commands fail with `{"error","message"}` JSON; show the message. */
function vbaErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.message === "string") return parsed.message;
  } catch {
    // not JSON
  }
  return raw;
}
```

`handleExportMacros` の catch も `setMacroError(vbaErrorMessage(e))` に。`vba-pushed` の購読(ブリッジ経由の push でもプレビューを更新):

```tsx
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ path: string }>("vba-pushed", (ev) => {
      const current = useTabStore.getState().getActiveTab()?.filePath;
      if (current && current === ev.payload.path) {
        reloadWorkbookTab(current).catch(() => {});
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [reloadWorkbookTab]);
```

i18n(ja / en の `editor.json`): 追加 `macroPushSuccess`(ja: `更新 {{updated}} / 追加 {{added}} / 削除 {{removed}}（バックアップ: .bak）`、en: `Updated {{updated}} / added {{added}} / removed {{removed}} (backup: .bak)`)。削除 `allowLlmVbaImport`、`allowLlmVbaImportHint`、`macroModuleSetChanged`、`macroImportSkipped`、`macroImportSuccess`。

README.md 88 行: `- Excel VBA macro editing in a dedicated chat (.xlsm / .xlam): extract, write back, add and remove modules`。README.ja.md 88 行: `- Excel VBA マクロの専用チャット編集（.xlsm / .xlam）— 展開・書き戻し・モジュールの追加・削除`。

- [ ] **Step 4: テスト実行**

Run: `npm test && npx tsc --noEmit`
Expected: 全 PASS(`PreviewPanel.test.tsx` は `MacroChatPane` をモックしているので Task 12 前でも通る。`./MacroChatPane` が無い間は `vi.mock` が解決できないので、空の `MacroChatPane.tsx`(`export function MacroChatPane() { return null; }`)をこのタスクで置き、Task 12 で本実装する)

- [ ] **Step 5: コミット**

```bash
git add -A src resources README.md README.ja.md
git commit -m "feat(vba): drop the mdium-vba MCP server and toggle; preview uses pull/push commands"
```

---

## Part C: 専用マクロチャット

### Task 10: `macro-chat-store`

**Files:**
- Create: `src/stores/macro-chat-store.ts`
- Test: `src/stores/macro-chat-store.test.ts`

**Interfaces:**
- Produces:
  - `export function workbookKey(path: string): string`(区切りを `/` に、小文字化)
  - `useMacroChatStore` state: `sessionByWorkbook: Record<string, string>`、`splitRatio: number`(初期 50)、`lockedByWorkbook: Record<string, boolean>`(非永続)
  - actions: `getSession(path): string | null`、`setSession(path, id: string | null)`、`setSplitRatio(r)`、`setLocked(path, locked)`、`isLocked(path): boolean`
  - persist 名 `mdium-macro-chat`、`partialize` は `sessionByWorkbook` と `splitRatio` のみ

- [ ] **Step 1: 失敗するテストを書く**

`src/stores/macro-chat-store.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useMacroChatStore, workbookKey } from "./macro-chat-store";

describe("macro-chat-store", () => {
  beforeEach(() => {
    useMacroChatStore.setState({ sessionByWorkbook: {}, splitRatio: 50, lockedByWorkbook: {} });
  });

  it("normalizes workbook keys (separators and case)", () => {
    expect(workbookKey("C:\\Work\\Book.XLSM")).toBe("c:/work/book.xlsm");
  });

  it("stores and clears the session per workbook", () => {
    const s = useMacroChatStore.getState();
    s.setSession("C:/w/Book.xlsm", "ses_1");
    expect(useMacroChatStore.getState().getSession("c:\\w\\book.xlsm")).toBe("ses_1");
    s.setSession("C:/w/Book.xlsm", null);
    expect(useMacroChatStore.getState().getSession("C:/w/Book.xlsm")).toBeNull();
    expect(useMacroChatStore.getState().sessionByWorkbook).toEqual({});
  });

  it("tracks lock state per workbook without persisting it", () => {
    useMacroChatStore.getState().setLocked("C:/w/Book.xlsm", true);
    expect(useMacroChatStore.getState().isLocked("C:/w/Book.xlsm")).toBe(true);
    const persisted = useMacroChatStore.persist.getOptions().partialize!(useMacroChatStore.getState());
    expect(persisted).not.toHaveProperty("lockedByWorkbook");
    expect(persisted).toHaveProperty("sessionByWorkbook");
    expect(persisted).toHaveProperty("splitRatio");
  });

  it("clamps the split ratio to 20..80", () => {
    useMacroChatStore.getState().setSplitRatio(5);
    expect(useMacroChatStore.getState().splitRatio).toBe(20);
    useMacroChatStore.getState().setSplitRatio(95);
    expect(useMacroChatStore.getState().splitRatio).toBe(80);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test -- src/stores/macro-chat-store.test.ts`
Expected: FAIL(モジュール未定義)

- [ ] **Step 3: 実装**

```ts
import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Case- and separator-insensitive key so the same workbook maps to one chat. */
export function workbookKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

interface MacroChatState {
  /** opencode session id bound to each workbook (keyed by workbookKey). */
  sessionByWorkbook: Record<string, string>;
  /** Width of the sheet preview pane in percent. */
  splitRatio: number;
  /** Latest check_workbook_lock result per workbook (not persisted). */
  lockedByWorkbook: Record<string, boolean>;
  getSession: (path: string) => string | null;
  setSession: (path: string, sessionId: string | null) => void;
  setSplitRatio: (ratio: number) => void;
  setLocked: (path: string, locked: boolean) => void;
  isLocked: (path: string) => boolean;
}

export const useMacroChatStore = create<MacroChatState>()(
  persist(
    (set, get) => ({
      sessionByWorkbook: {},
      splitRatio: 50,
      lockedByWorkbook: {},
      getSession: (path) => get().sessionByWorkbook[workbookKey(path)] ?? null,
      setSession: (path, sessionId) =>
        set((s) => {
          const next = { ...s.sessionByWorkbook };
          if (sessionId) next[workbookKey(path)] = sessionId;
          else delete next[workbookKey(path)];
          return { sessionByWorkbook: next };
        }),
      setSplitRatio: (ratio) => set({ splitRatio: Math.max(20, Math.min(80, ratio)) }),
      setLocked: (path, locked) =>
        set((s) => ({ lockedByWorkbook: { ...s.lockedByWorkbook, [workbookKey(path)]: locked } })),
      isLocked: (path) => get().lockedByWorkbook[workbookKey(path)] ?? false,
    }),
    {
      name: "mdium-macro-chat",
      partialize: (s) => ({ sessionByWorkbook: s.sessionByWorkbook, splitRatio: s.splitRatio }),
    },
  ),
);
```

- [ ] **Step 4: テスト実行**

Run: `npm test -- src/stores/macro-chat-store.test.ts`
Expected: 4 件 PASS

- [ ] **Step 5: コミット**

```bash
git add src/stores/macro-chat-store.ts src/stores/macro-chat-store.test.ts
git commit -m "feat(macro-chat): persisted workbook-to-session store"
```

### Task 11: `OpencodeChat` の `variant` / `header` / `placeholder`

**Files:**
- Modify: `src/features/opencode-config/components/OpencodeChat.tsx`(シグネチャ 27 行、toolbar 391-456 行、status 462-475 行、md-toggle-row 557-574 行、textarea placeholder 605 行、history dialog 643-690 行)
- Test: `src/features/opencode-config/components/OpencodeChat.test.tsx`

**Interfaces:**
- Produces: `export interface OpencodeChatProps { variant?: "panel" | "macro"; header?: React.ReactNode; placeholder?: string }`。`variant="macro"` では toolbar(新規・履歴・エージェント選択・接続バッジ)、md-toggle 行、履歴ダイアログを描画せず、代わりに `header` を先頭に描画し、入力欄の placeholder に `placeholder` を使う。エラー表示と「接続」ボタンの行(`oc-chat__status`)は両方で描画

- [ ] **Step 1: 失敗するテストを書く**

`src/features/opencode-config/components/OpencodeChat.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpencodeChat } from "./OpencodeChat";
import { useChatUIStore } from "../hooks/useOpencodeChat";
import { useTabStore } from "@/stores/tab-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn(), exists: vi.fn() }));

async function render(ui: React.ReactElement) {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(ui));
  return { container, unmount: () => act(async () => root.unmount()) };
}

describe("OpencodeChat variants", () => {
  beforeEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null, activeFolderPath: null });
    useChatUIStore.setState({ connected: true, connecting: false, messages: [], loading: false });
  });
  afterEach(() => {
    useChatUIStore.setState({ connected: false });
  });

  it("panel variant renders the toolbar and md toggle", async () => {
    const { container, unmount } = await render(<OpencodeChat />);
    expect(container.querySelector(".oc-chat__toolbar")).not.toBeNull();
    expect(container.querySelector(".oc-chat__md-toggle-row")).not.toBeNull();
    await unmount();
  });

  it("macro variant renders the header instead and uses the custom placeholder", async () => {
    const { container, unmount } = await render(
      <OpencodeChat variant="macro" header={<div data-testid="hdr">H</div>} placeholder="Describe the change" />,
    );
    expect(container.querySelector('[data-testid="hdr"]')).not.toBeNull();
    expect(container.querySelector(".oc-chat__toolbar")).toBeNull();
    expect(container.querySelector(".oc-chat__md-toggle-row")).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>(".oc-chat__input")?.placeholder).toBe("Describe the change");
    await unmount();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test -- src/features/opencode-config/components/OpencodeChat.test.tsx`
Expected: 2 件目が FAIL(`header` 未描画、toolbar あり)

- [ ] **Step 3: 実装**

```tsx
export interface OpencodeChatProps {
  /** "panel": the left-panel chat with toolbar and history. "macro": embedded
   * in a workbook tab; the caller supplies the header instead of the toolbar. */
  variant?: "panel" | "macro";
  header?: React.ReactNode;
  placeholder?: string;
}

export function OpencodeChat({ variant = "panel", header, placeholder }: OpencodeChatProps = {}) {
  const isMacro = variant === "macro";
  // ...
```

描画部:
- `{/* Toolbar */}` のブロック全体を `{!isMacro && ( <div className="oc-chat__toolbar"> ... </div> )}` で囲み、その直前に `{isMacro && header}` を置く
- `{/* MD context toggle and session usage */}` の `<div className="oc-chat__md-toggle-row">` を `{!isMacro && (...)}` で囲む
- textarea の `placeholder={connected ? (placeholder ?? t("ocChatPlaceholder")) : t("ocChatDisconnected")}`
- `{showHistory && (...)}` を `{!isMacro && showHistory && (...)}` に

`OpencodeConfigPanel.tsx` の `<OpencodeChat />` はそのまま(既定が `panel`)。

- [ ] **Step 4: テスト実行**

Run: `npm test -- src/features/opencode-config/components/OpencodeChat.test.tsx && npx tsc --noEmit`
Expected: 2 件 PASS

- [ ] **Step 5: コミット**

```bash
git add src/features/opencode-config/components/OpencodeChat.tsx src/features/opencode-config/components/OpencodeChat.test.tsx
git commit -m "feat(opencode-chat): macro variant with caller-supplied header"
```

### Task 12: `MacroChatPane`(ヘッダ・ロック警告・セッション紐づけ)

**Files:**
- Create: `src/features/preview/components/MacroChatPane.tsx`(Task 9 の空実装を置き換え)、`MacroChatPane.css`
- Modify: `src/shared/i18n/locales/ja/editor.json`、`en/editor.json`(仕様 6.7 のキー)
- Test: `src/features/preview/components/MacroChatPane.test.tsx`

**Interfaces:**
- Consumes: Task 10 の `useMacroChatStore`、Task 11 の `<OpencodeChat variant="macro" header placeholder />`、Task 9 の `doConnect` / `doLoadSession` / `doCreateNewSession` / `useChatUIStore`、Rust `list_vba_modules` / `check_workbook_lock`
- Produces: `export interface MacroChatPaneProps { filePath: string; fileName: string; folderPath: string | null }`、`export function MacroChatPane(props)`
- i18n(`editor`): `macroChatTitle`、`macroChatNewChat`、`macroChatModules`、`macroChatExtracted`、`macroChatPlaceholder`、`macroChatNeedsFolder`、`macroChatNoMacros`、`workbookLocked`、`workbookLockRecheck`

- [ ] **Step 1: 失敗するテストを書く**

`src/features/preview/components/MacroChatPane.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MacroChatPane } from "./MacroChatPane";
import { useMacroChatStore } from "@/stores/macro-chat-store";
import { useChatUIStore } from "@/features/opencode-config/hooks/useOpencodeChat";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn(), exists: vi.fn() }));

const doConnect = vi.fn().mockResolvedValue(undefined);
const doLoadSession = vi.fn().mockResolvedValue(undefined);
const doCreateNewSession = vi.fn().mockResolvedValue(undefined);
vi.mock("@/features/opencode-config/hooks/useOpencodeChat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/opencode-config/hooks/useOpencodeChat")>();
  return {
    ...actual,
    doConnect: (...a: unknown[]) => doConnect(...a),
    doLoadSession: (...a: unknown[]) => doLoadSession(...a),
    doCreateNewSession: (...a: unknown[]) => doCreateNewSession(...a),
  };
});
vi.mock("@/features/opencode-config/components/OpencodeChat", () => ({
  OpencodeChat: ({ header }: { header: React.ReactNode }) => <div data-testid="chat">{header}</div>,
}));

const props = { filePath: "C:/project/book.xlsm", fileName: "book.xlsm", folderPath: "C:/project" };
const listOk = {
  xlsmPath: props.filePath,
  macrosDir: "C:/project/book_assets/macros",
  extracted: true,
  locked: false,
  modules: [
    { name: "Module1", moduleType: "standard", path: "C:/project/book_assets/macros/Module1.bas" },
    { name: "ThisWorkbook", moduleType: "document", path: null },
  ],
};

async function render(ui: React.ReactElement) {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(ui));
  return { container, unmount: () => act(async () => root.unmount()) };
}

describe("MacroChatPane", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    invoke.mockReset();
    doConnect.mockClear();
    doLoadSession.mockClear();
    doCreateNewSession.mockClear();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_vba_modules") return listOk;
      if (cmd === "check_workbook_lock") return { locked: false, reason: null };
      return null;
    });
    useMacroChatStore.setState({ sessionByWorkbook: {}, lockedByWorkbook: {} });
    useChatUIStore.setState({ currentSessionId: null });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists modules with kinds and marks extracted ones", async () => {
    const { container, unmount } = await render(<MacroChatPane {...props} />);
    const items = [...container.querySelectorAll(".macro-chat__module")].map((n) => n.textContent);
    expect(items[0]).toContain("Module1");
    expect(items[0]).toContain("standard");
    expect(container.querySelectorAll(".macro-chat__module--extracted").length).toBe(1);
    await unmount();
  });

  it("creates a new session when the workbook has none, and records the id once sent", async () => {
    const { unmount } = await render(<MacroChatPane {...props} />);
    expect(doConnect).toHaveBeenCalledWith("C:/project");
    expect(doCreateNewSession).toHaveBeenCalledTimes(1);
    expect(doLoadSession).not.toHaveBeenCalled();
    await act(async () => useChatUIStore.setState({ currentSessionId: "ses_new" }));
    expect(useMacroChatStore.getState().getSession(props.filePath)).toBe("ses_new");
    await unmount();
  });

  it("loads the bound session when one exists", async () => {
    useMacroChatStore.getState().setSession(props.filePath, "ses_old");
    const { unmount } = await render(<MacroChatPane {...props} />);
    expect(doLoadSession).toHaveBeenCalledWith("ses_old");
    expect(doCreateNewSession).not.toHaveBeenCalled();
    await unmount();
  });

  it("falls back to a new session when loading the bound one fails", async () => {
    useMacroChatStore.getState().setSession(props.filePath, "ses_gone");
    doLoadSession.mockRejectedValueOnce(new Error("404"));
    const { unmount } = await render(<MacroChatPane {...props} />);
    expect(doCreateNewSession).toHaveBeenCalledTimes(1);
    expect(useMacroChatStore.getState().getSession(props.filePath)).toBeNull();
    await unmount();
  });

  it("new chat button clears the binding and starts a fresh session", async () => {
    useMacroChatStore.getState().setSession(props.filePath, "ses_old");
    const { container, unmount } = await render(<MacroChatPane {...props} />);
    const btn = container.querySelector<HTMLButtonElement>(".macro-chat__new-chat")!;
    await act(async () => btn.click());
    expect(useMacroChatStore.getState().getSession(props.filePath)).toBeNull();
    expect(doCreateNewSession).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it("shows the lock banner, re-checks every 5 seconds, and hides it when unlocked", async () => {
    let locked = true;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_vba_modules") return { ...listOk, locked };
      if (cmd === "check_workbook_lock") return { locked, reason: locked ? "owner_file" : null };
      return null;
    });
    const { container, unmount } = await render(<MacroChatPane {...props} />);
    expect(container.querySelector(".macro-chat__lock")).not.toBeNull();
    expect(useMacroChatStore.getState().isLocked(props.filePath)).toBe(true);
    locked = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    expect(container.querySelector(".macro-chat__lock")).toBeNull();
    expect(useMacroChatStore.getState().isLocked(props.filePath)).toBe(false);
    await unmount();
  });

  it("shows a hint instead of the chat when no folder is open", async () => {
    const { container, unmount } = await render(<MacroChatPane {...props} folderPath={null} />);
    expect(container.querySelector(".macro-chat__needs-folder")).not.toBeNull();
    expect(container.querySelector('[data-testid="chat"]')).toBeNull();
    expect(doConnect).not.toHaveBeenCalled();
    await unmount();
  });

  it("reports a workbook without macros instead of failing", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_vba_modules") throw new Error(JSON.stringify({ error: "no_vba_project", message: "No VBA macros" }));
      if (cmd === "check_workbook_lock") return { locked: false, reason: null };
      return null;
    });
    const { container, unmount } = await render(<MacroChatPane {...props} />);
    expect(container.querySelector(".macro-chat__no-macros")).not.toBeNull();
    expect(container.querySelectorAll(".macro-chat__module").length).toBe(0);
    await unmount();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test -- src/features/preview/components/MacroChatPane.test.tsx`
Expected: FAIL(空実装のため要素が無い)

- [ ] **Step 3: 実装**

i18n 追加(`editor.json`):

| キー | ja | en |
|---|---|---|
| `macroChatTitle` | マクロ編集 | Macro editing |
| `macroChatNewChat` | 新しいチャット | New chat |
| `macroChatModules` | モジュール | Modules |
| `macroChatExtracted` | 展開済み | Extracted |
| `macroChatPlaceholder` | このブックのマクロへの変更内容を書いてください | Describe the change you want in this workbook's macros |
| `macroChatNeedsFolder` | フォルダを開くとマクロチャットを使えます | Open a folder to use the macro chat |
| `macroChatNoMacros` | このブックにはマクロがありません | This workbook has no macros |
| `workbookLocked` | Excel で開かれています。閉じてから編集してください | This workbook is open in Excel. Close it before editing |
| `workbookLockRecheck` | 再確認 | Check again |

`MacroChatPane.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { OpencodeChat } from "@/features/opencode-config/components/OpencodeChat";
import {
  doConnect,
  doCreateNewSession,
  doLoadSession,
  useChatUIStore,
} from "@/features/opencode-config/hooks/useOpencodeChat";
import { useMacroChatStore } from "@/stores/macro-chat-store";
import "./MacroChatPane.css";

const LOCK_RECHECK_MS = 5000;

interface VbaModule {
  name: string;
  moduleType: string;
  path: string | null;
}

interface ListResult {
  extracted: boolean;
  locked: boolean;
  modules: VbaModule[];
}

interface WorkbookLock {
  locked: boolean;
  reason: string | null;
}

export interface MacroChatPaneProps {
  filePath: string;
  fileName: string;
  folderPath: string | null;
}

/** Message of a `{"error","message"}` command failure, or the raw text. */
function errorInfo(e: unknown): { code: string | null; message: string } {
  const raw = e instanceof Error ? e.message : String(e);
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.message === "string") return { code: parsed.error ?? null, message: parsed.message };
  } catch {
    // not JSON
  }
  return { code: null, message: raw };
}

export function MacroChatPane({ filePath, fileName, folderPath }: MacroChatPaneProps) {
  const { t } = useTranslation("editor");
  const [list, setList] = useState<ListResult | null>(null);
  const [noMacros, setNoMacros] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [lock, setLock] = useState<WorkbookLock>({ locked: false, reason: null });
  const setLocked = useMacroChatStore((s) => s.setLocked);
  const currentSessionId = useChatUIStore((s) => s.currentSessionId);
  // True while this pane owns the shared chat session (between bind and unmount).
  const boundRef = useRef(false);

  const refreshModules = useCallback(async () => {
    try {
      const res = await invoke<ListResult>("list_vba_modules", { xlsmPath: filePath });
      setList(res);
      setNoMacros(false);
      setListError(null);
    } catch (e) {
      const info = errorInfo(e);
      setList(null);
      setNoMacros(info.code === "no_vba_project");
      setListError(info.code === "no_vba_project" ? null : info.message);
    }
  }, [filePath]);

  const checkLock = useCallback(async () => {
    try {
      const res = await invoke<WorkbookLock>("check_workbook_lock", { xlsmPath: filePath });
      setLock(res);
      setLocked(filePath, res.locked);
    } catch {
      // Leave the push-side check to decide; no banner on probe failure.
    }
  }, [filePath, setLocked]);

  // Bind the shared chat to this workbook's session.
  useEffect(() => {
    if (!folderPath) return;
    let cancelled = false;
    boundRef.current = false;
    (async () => {
      await doConnect(folderPath);
      if (cancelled) return;
      const store = useMacroChatStore.getState();
      const bound = store.getSession(filePath);
      if (bound) {
        try {
          await doLoadSession(bound);
        } catch {
          store.setSession(filePath, null);
          await doCreateNewSession();
        }
      } else {
        await doCreateNewSession();
      }
      if (!cancelled) boundRef.current = true;
    })();
    return () => {
      cancelled = true;
      boundRef.current = false;
    };
  }, [filePath, folderPath]);

  // Remember the session opencode creates on the first message.
  useEffect(() => {
    if (!boundRef.current || !currentSessionId) return;
    const store = useMacroChatStore.getState();
    if (store.getSession(filePath) !== currentSessionId) store.setSession(filePath, currentSessionId);
  }, [currentSessionId, filePath]);

  useEffect(() => {
    refreshModules();
    checkLock();
  }, [refreshModules, checkLock]);

  // While locked, poll so the banner clears itself once Excel closes the file.
  useEffect(() => {
    if (!lock.locked) return;
    const timer = setInterval(checkLock, LOCK_RECHECK_MS);
    return () => clearInterval(timer);
  }, [lock.locked, checkLock]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ path: string }>("vba-pushed", (ev) => {
      if (ev.payload.path === filePath) {
        refreshModules();
        checkLock();
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [filePath, refreshModules, checkLock]);

  const handleNewChat = useCallback(async () => {
    useMacroChatStore.getState().setSession(filePath, null);
    await doCreateNewSession();
  }, [filePath]);

  if (!folderPath) {
    return (
      <div className="macro-chat">
        <div className="macro-chat__needs-folder">{t("macroChatNeedsFolder")}</div>
      </div>
    );
  }

  const header = (
    <div className="macro-chat__header">
      <div className="macro-chat__title-row">
        <span className="macro-chat__title">{t("macroChatTitle")}</span>
        <span className="macro-chat__file" title={filePath}>{fileName}</span>
        <button type="button" className="macro-chat__new-chat" onClick={handleNewChat}>
          {t("macroChatNewChat")}
        </button>
      </div>
      {lock.locked && (
        <div className="macro-chat__lock" role="alert">
          <span>{t("workbookLocked")}</span>
          <button type="button" onClick={checkLock}>{t("workbookLockRecheck")}</button>
        </div>
      )}
      {noMacros && <div className="macro-chat__no-macros">{t("macroChatNoMacros")}</div>}
      {listError && <div className="macro-chat__error">{listError}</div>}
      {list && (
        <div className="macro-chat__modules">
          <span className="macro-chat__modules-label">{t("macroChatModules")}</span>
          {list.modules.map((m) => (
            <span
              key={m.name}
              className={`macro-chat__module${m.path ? " macro-chat__module--extracted" : ""}`}
              title={m.path ? t("macroChatExtracted") : undefined}
            >
              {m.name} <small>{m.moduleType}</small>
            </span>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="macro-chat">
      <OpencodeChat variant="macro" header={header} placeholder={t("macroChatPlaceholder")} />
    </div>
  );
}
```

`MacroChatPane.css`(`.macro-chat` は `display:flex; flex-direction:column; flex:1; min-height:0; min-width:0`、ヘッダは `border-bottom: 1px solid var(--border); padding: 6px 10px; font-size: 12px`、`.macro-chat__lock` は `background: var(--warning-bg, #fff4e5); color: var(--warning-fg, #8a4b00); padding: 6px 8px; border-radius: 4px; display:flex; gap:8px; align-items:center`、`.macro-chat__module` は `display:inline-block; margin-right:8px; opacity:.7`、`--extracted` は `opacity:1; font-weight:600`、`.macro-chat__needs-folder` / `__no-macros` は `padding:12px; color: var(--text-muted)`)。

- [ ] **Step 4: テスト実行**

Run: `npm test -- src/features/preview/components/MacroChatPane.test.tsx && npx tsc --noEmit`
Expected: 8 件 PASS

- [ ] **Step 5: コミット**

```bash
git add src/features/preview/components/MacroChatPane.tsx src/features/preview/components/MacroChatPane.css src/features/preview/components/MacroChatPane.test.tsx src/shared/i18n/locales
git commit -m "feat(macro-chat): workbook-bound chat pane with module list and Excel lock warning"
```

### Task 13: PreviewPanel の分割表示とロック連動

**Files:**
- Modify: `src/features/preview/components/PreviewPanel.tsx`(Office 分岐 1276-1360 行、import)
- Modify: `src/features/preview/components/PreviewPanel.css`
- Test: `src/features/preview/components/PreviewPanel.test.tsx`(Task 9 のファイルに追記)

**Interfaces:**
- Consumes: Task 10 の `useMacroChatStore`(`splitRatio`、`setSplitRatio`、`isLocked`)、Task 12 の `<MacroChatPane filePath fileName folderPath />`、`useDividerDrag`
- Produces: xlsm / xlam タブで `.preview-panel__macro-split`(左 `.preview-panel__macro-left`、`.preview-panel__macro-divider`、右 `MacroChatPane`)。「マクロを取り込み」はロック中 `disabled` で `title` に `workbookLocked`

- [ ] **Step 1: 失敗するテストを書く**

`PreviewPanel.test.tsx` の describe に追記:

```tsx
  it("splits an xlsm tab into sheet preview and macro chat", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<PreviewPanel previewRef={{ current: null }} />));
    expect(container.querySelector(".preview-panel__macro-split")).not.toBeNull();
    expect(container.querySelector('[data-testid="macro-chat"]')).not.toBeNull();
    const left = container.querySelector<HTMLElement>(".preview-panel__macro-left")!;
    expect(left.style.flexBasis).toBe("50%");
    await act(async () => root.unmount());
  });

  it("does not split a plain xlsx tab", async () => {
    useTabStore.setState({ tabs: [{ ...tab, id: "x", filePath: "C:/project/plain.xlsx", fileName: "plain.xlsx", officeFileType: ".xlsx" }], activeTabId: "x" });
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<PreviewPanel previewRef={{ current: null }} />));
    expect(container.querySelector(".preview-panel__macro-split")).toBeNull();
    expect(container.querySelector('[data-testid="macro-chat"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it("disables the import button while Excel holds the workbook", async () => {
    useMacroChatStore.getState().setLocked(tab.filePath, true);
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<PreviewPanel previewRef={{ current: null }} />));
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".preview-panel__convert-bar button")];
    const importBtn = buttons.find((b) => b.textContent?.includes("取り込み") || b.textContent?.includes("Load"))!;
    expect(importBtn.disabled).toBe(true);
    expect(importBtn.title.length).toBeGreaterThan(0);
    useMacroChatStore.getState().setLocked(tab.filePath, false);
    await act(async () => root.unmount());
  });
```

(ファイル先頭に `import { useMacroChatStore } from "@/stores/macro-chat-store";` を追加し、`beforeEach` で `useMacroChatStore.setState({ splitRatio: 50, lockedByWorkbook: {} })`。)

- [ ] **Step 2: 失敗を確認**

Run: `npm test -- src/features/preview/components/PreviewPanel.test.tsx`
Expected: 3 件 FAIL

- [ ] **Step 3: 実装**

`PreviewPanel.tsx` の import に:

```tsx
import { MacroChatPane } from "./MacroChatPane";
import { useMacroChatStore } from "@/stores/macro-chat-store";
import { useDividerDrag } from "@/shared/hooks/useDividerDrag";
```

コンポーネント内(フックは早期 return より前に置く):

```tsx
  const macroSplitRatio = useMacroChatStore((s) => s.splitRatio);
  const setMacroSplitRatio = useMacroChatStore((s) => s.setSplitRatio);
  const workbookLocked = useMacroChatStore((s) => (activeTab?.filePath ? s.isLocked(activeTab.filePath) : false));
  const macroSplitRef = useRef<HTMLDivElement>(null);
  const handleMacroDividerDown = useDividerDrag(macroSplitRef, macroSplitRatio, setMacroSplitRatio, 20, 80);
```

Office 分岐を次の形にする(変換バーと `OfficePreview` は従来どおり `officeBody` として組み、`isMacroEnabled` のときだけ分割):

```tsx
  if (isOfficeFile) {
    const officeBody = (
      <>
        {(isDocx || isPdf || isXlsx) && (
          <div className="preview-panel__convert-bar">
            {/* existing convert button */}
            {isMacroEnabled && (
              <button onClick={handleExportMacros} disabled={macroExporting || macroImporting} title={t("exportMacrosHint") ?? ""}>
                {macroExporting ? t("exportingMacros") : t("exportMacros")}
              </button>
            )}
            {isMacroEnabled && macrosDirExists && (
              <button
                onClick={handleImportMacros}
                disabled={macroImporting || macroExporting || workbookLocked}
                title={workbookLocked ? t("workbookLocked") : (t("importMacrosHint") ?? "")}
              >
                {macroImporting ? t("importingMacros") : t("importMacros")}
              </button>
            )}
            {/* existing convertError / macroError / macroSuccess spans */}
          </div>
        )}
        <div className="preview-panel__office-wrap" ref={previewRef}>
          <OfficePreview key={activeTab!.filePath} fileData={activeTab!.binaryData!} fileType={activeTab!.officeFileType!} themeType={themeType} />
        </div>
      </>
    );

    if (isMacroEnabled && activeTab?.filePath) {
      return (
        <div className="preview-panel">
          <div className="preview-panel__macro-split" ref={macroSplitRef}>
            <div className="preview-panel__macro-left" style={{ flexBasis: `${macroSplitRatio}%` }}>
              {officeBody}
            </div>
            <div className="preview-panel__macro-divider" onMouseDown={handleMacroDividerDown} />
            <div className="preview-panel__macro-right">
              <MacroChatPane filePath={activeTab.filePath} fileName={activeTab.fileName} folderPath={activeTab.folderPath || null} />
            </div>
          </div>
        </div>
      );
    }

    return <div className="preview-panel">{officeBody}</div>;
  }
```

`PreviewPanel.css` に追加:

```css
.preview-panel__macro-split {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.preview-panel__macro-left {
  display: flex;
  flex-direction: column;
  flex: 0 0 50%;
  min-width: 0;
  overflow: hidden;
}

.preview-panel__macro-divider {
  flex: 0 0 4px;
  cursor: col-resize;
  background: var(--border);
}

.preview-panel__macro-divider:hover {
  background: var(--primary);
}

.preview-panel__macro-right {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
```

- [ ] **Step 4: テスト実行**

Run: `npm test && npx tsc --noEmit && cd src-tauri && cargo test vba && cargo build`
Expected: 全 PASS、ビルド成功

- [ ] **Step 5: コミット**

```bash
git add src/features/preview/components/PreviewPanel.tsx src/features/preview/components/PreviewPanel.css src/features/preview/components/PreviewPanel.test.tsx
git commit -m "feat(preview): split xlsm tabs into sheet preview and macro chat"
```

---

## 仕上げ

### 最終確認(実装者)

- [ ] `npm test`、`npx tsc --noEmit`、`cd src-tauri && cargo test && cargo build` が緑
- [ ] `grep -rn "allowLlmVbaImport\|mdium-vba\|set_active_xlsm_path\|extract_vba_modules\|inject_vba_modules\|module_set_changed" src src-tauri/src resources docs README*.md` がヒット 0 件(`release_notes/` は履歴なので除外)
- [ ] `docs/builtin-skills.ja.md` の `vba-mdium-flow` 節が Task 8 のスキル内容と一致

### 実機スモーク(利用者、仕様 9 章)

1. `.xlsm` を開く → 分割表示。チャットに「Module1 の Hello に引数を足して」→ `vba_list` → `vba_pull` → 編集 → `vba_push` が走り、Excel で動く
2. 「Helpers モジュールとクラス NewClass を追加して」→ VBE に現れ実行できる(仕様 4.8 のリスク確認)
3. 「Helpers を削除して」→ VBE から消える
4. 日本語文字列と Shift_JIS ブック、`.xlam`
5. Excel で開いたままタブを開く → バナー表示。閉じると 5 秒以内に消える。開いたまま push → `workbook_locked`
6. タブを閉じて開き直す → 前回の会話に戻る。「新しいチャット」で白紙になる

