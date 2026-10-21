# VBA Run & Verify Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the macro chat's AI run VBA macros on a disposable copy of the workbook (built from the original plus the current `.bas`/`.cls` sources), read cell values back, and iterate until the values match, without ever writing unverified code to the original workbook.

**Architecture:** `vba.rs` is split into a pure planning step (`plan_push` / `apply_changes`) that both `vba_push` and the new `vba_run` reuse. `vba_run.rs` builds a run copy under `<stem>_assets/runs/<ts>_<macro>/`, injects a generated `MdiumShim` module (shadows `MsgBox`/`InputBox`, wraps each macro in `On Error`), drives Excel through a PowerShell COM script (same pattern as `doc_convert.rs`), and while waiting dismisses any dialog window of that Excel PID via Win32 messages (`vba_dialog_watch.rs`, `windows-sys`). `xlsx_read.rs` reads saved cell values with `calamine`. The HTTP bridge gains `/vba/run` and `/xlsx/read`; a per-workbook run budget and a side-effect approval (relayed to the webview like RAG approvals) are enforced in Rust. Two opencode tools and skill v4 teach the loop.

**Tech Stack:** Rust (Tauri 2, tiny_http, serde, zip, cfb, regex, sha2, **calamine**, **windows-sys**), PowerShell 5+ + Excel COM, React 18 + zustand + react-i18next + vitest, opencode custom tools (`@opencode-ai/plugin`).

**Spec:** `.superpowers/specs/2026-10-21-vba-run-verify-design.md`

**Deviations from the spec (decided while planning, from facts found in the code):**
1. `xlsx_read` resolves paths exactly like the vba tools (absolute passes through, relative resolves against the open folder) and only checks the extension; it does not additionally require the path to be under the open folder. Reason: `resolve_xlsm_path` already exists and the vba tools behave that way.
2. A macro whose `#32770` dialog text parses as a VBE run-time error gets `status: "error"` with `error.from: "dialog"`; `dialog_interrupted` is used only when no error text was recovered. (Spec 3.5 / 4.3 left the two readings open.)
3. Run-copy file name: the macro part of `<yyyyMMdd-HHmmss>_<macro>` is the procedure name only (no module prefix), `read` when `macros` is empty; a same-second collision appends `-2`, `-3`, …
4. Budget reset in `doAnswerQuestions` is wired but only unit-tested through the shared helper; `doSendMessage` gets a direct test.

## Global Constraints

- All UI-visible strings go through i18n (`src/shared/i18n/locales/{en,ja}/editor.json`); `src/shared/i18n/__tests__/locale-parity.test.ts` enforces en/ja parity. Tool/bridge error messages are agent-facing English JSON (existing `vba_error` style) and are not i18n.
- Code comments in English. Files are CRLF; keep existing line endings.
- No dynamic `import()` in the webview.
- The original workbook is written only by `vba_push` (unchanged behavior, `.bak` first). `vba_run` never writes it.
- Constants (exact values): `VBA_RUN_BUDGET = 6`, `RUN_COPY_KEEP = 5`, `DEFAULT_TIMEOUT_MS = 120_000`, `MAX_TIMEOUT_MS = 300_000`, `APPROVAL_TIMEOUT_MS = 120_000`, `WATCH_INTERVAL_MS = 250`, `MAX_READ_CELLS = 20_000`, `SHIM_MODULE_NAME = "MdiumShim"`, approval dialog shows at most 20 match lines.
- Workbook key (Rust and TS must agree): backslashes → `/`, then ASCII-lowercase. TS already has `workbookKey` in `src/stores/macro-chat-store.ts`.
- PowerShell script is passed via `-Command`, uses **single quotes only**, receives paths/JSON through environment variables, started with `CREATE_NO_WINDOW` (copy the pattern in `src-tauri/src/commands/doc_convert.rs`).
- Error codes/HTTP statuses added to `status_for_vba_error`: `run_budget_exhausted` 429, `run_in_progress` 409, `approval_denied` 403, `approval_timeout` 408; everything else keeps the existing rule (`*_failed` 500, else 400).
- Verify with: `npx vitest run <file>`, `npx tsc --noEmit`, `cd src-tauri && cargo test --lib`. Excel-dependent tests are `#[ignore]` and run manually with `cargo test --lib -- --ignored vba_run_excel`.

## Review Focus

1. **A `.bas` edited in the macros dir while `source: "workbook"` is requested** must run the *original* code, not the folder's. Test in Task 7 (`workbook_source_ignores_macros_dir`).
2. **A macro name that exists in two modules** (`Helper` in `Module1` and `Utils`) with `name: "Helper"` must fail with `macro_not_found` naming both, not pick one silently. Test in Task 2 (`resolve_macro_rejects_ambiguous_unqualified_name`).
3. **Dialog text containing a Japanese run-time error** (`実行時エラー '9':`) and the English form must both yield the number and description. Test in Task 5 (`parses_vbe_error_text_in_japanese_and_english`).
4. **A `read` range that is a single cell** comes back from COM as a scalar, not a 2-D array; the result must still be `[[value]]`. Pinned in the PowerShell script of Task 7 and the parser test `cells_payload_single_value_becomes_one_by_one` in Task 5.
5. **Timestamp collision within one second** for two runs must not overwrite the first run copy. Test in Task 5 (`new_run_dir_appends_suffix_on_collision`).

---

## File structure

| File | Responsibility |
|---|---|
| `src-tauri/src/commands/vba.rs` (modify) | Split push into `plan_push` + `apply_changes`; `ModuleSource`, `PushWarning`, `warnings` on `PushResult`; `project_sources`, `add_module`, `workbook_key` |
| `src-tauri/src/commands/vba_lint.rs` (new) | Lint (`on_error_resume_next_added`, `duplicate_procedure`), side-effect scan, procedure lookup |
| `src-tauri/src/commands/vba_shim.rs` (new) | `MdiumShim` VBA generation, VBA literal escaping |
| `src-tauri/src/commands/xlsx_read.rs` (new) | `calamine` range reading, A1 parsing, `CellBlock`, Excel error labels |
| `src-tauri/src/commands/vba_run.rs` (new) | Request/response types, `VbaRunState` (budget / approvals / in-progress / pending approvals), run-copy directories, runner stdout protocol parsing, VBE error text parsing, PowerShell script, orchestration, Tauri commands |
| `src-tauri/src/commands/vba_dialog_watch.rs` (new) | Win32 window scan + dismiss (`cfg(windows)`), process termination; no-op stub elsewhere |
| `src-tauri/src/http_bridge.rs` (modify) | Routes `/vba/run`, `/xlsx/read`; status codes |
| `src-tauri/src/lib.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/Cargo.toml` (modify) | Registration, state, dependencies |
| `.opencode/tools/vba_run.ts`, `.opencode/tools/xlsx_read.ts` (new) | opencode tools calling the bridge |
| `src/features/opencode-config/lib/builtin-registry.ts`, `builtin-skills.ts` (modify) | Register tools; skill v4 |
| `src/features/preview/hooks/useVbaRunApproval.ts` (new), `src/app/App.tsx` (modify) | Approval dialog relay |
| `src/features/opencode-config/lib/vba-run-budget.ts` (new), `hooks/useOpencodeChat.ts`, `src/features/preview/components/MacroChatPane.tsx` (modify) | Budget reset on user actions |
| `src/shared/i18n/locales/{en,ja}/editor.json` (modify) | Approval dialog strings |

---

### Task 1: Split push into plan + apply (`vba.rs`)

**Files:**
- Modify: `src-tauri/src/commands/vba.rs` (around `push_vba_modules_impl`, lines 751–936, and `PushResult` at 630)
- Test: same file, `mod tests`

**Interfaces:**
- Produces (all in `vba.rs`, `pub`):
```rust
#[derive(Debug, Clone)]
pub struct ModuleSource { pub name: String, pub kind: ModuleKind, pub source: String }   // decoded source, VB_Name fixed, not normalized
#[derive(Debug, Clone)]
pub struct ModuleEdit { pub name: String, pub kind: ModuleKind, pub source: String /* normalized */, pub private: bool }
#[derive(Debug, Clone, Default)]
pub struct ModuleChanges { pub updated: Vec<ModuleEdit>, pub added: Vec<ModuleEdit>, pub removed: Vec<String> }
impl ModuleChanges { pub fn is_empty(&self) -> bool }
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum PushWarning {
    OnErrorResumeNextAdded { module: String, before: usize, after: usize },
    DuplicateProcedure { name: String, modules: Vec<String> },
}
pub struct PushPlan {
    pub changes: ModuleChanges,
    pub unchanged: Vec<String>,
    pub skipped: Vec<SkippedModule>,
    pub warnings: Vec<PushWarning>,      // empty in this task; Task 2 fills it
    pub before: Vec<ModuleSource>,       // workbook modules (non-Form) before the plan
    pub after: Vec<ModuleSource>,        // modules as they would be after apply (normalized sources for touched ones)
}
pub fn vba_project_bin_from_zip(xlsm_data: &[u8]) -> Result<Vec<u8>, String>;
pub fn project_sources(xlsm_data: &[u8]) -> Result<Vec<ModuleSource>, String>;   // Err = plain message (caller wraps)
pub fn plan_push(xlsm_data: &[u8], macros_dir: &Path) -> Result<PushPlan, String>;  // Err = vba_error JSON (same codes as today)
pub fn apply_changes(xlsm_data: &[u8], changes: &ModuleChanges) -> Result<Vec<u8>, String>; // new xlsm bytes; Err = vba_error JSON
pub fn add_module(xlsm_data: &[u8], name: &str, kind: ModuleKind, source: &str) -> Result<Vec<u8>, String>; // normalize + apply one added module
pub fn workbook_key(path: &str) -> String;
```
- `PushResult` gains `pub warnings: Vec<PushWarning>` (serialized as `warnings`, `[]` when none).
- `push_vba_modules_impl(xlsm_path)` keeps its signature and behavior: checks (`require_macro_workbook`, `macros_dir_not_found`, `workbook_locked`), `fs::read`, `plan_push`, return no-backup result when `changes.is_empty()`, else `.bak` + `apply_changes` + `fs::write`.

- [ ] **Step 1: Add failing tests** in `mod tests` of `vba.rs`:

```rust
#[test]
fn plan_push_reports_changes_without_writing() {
    let dir = tempfile::tempdir().unwrap();  // if tempfile is not a dev-dep, use std::env::temp_dir() + unique subdir like the existing tests do
    let xlsm = three_module_workbook(dir.path());
    pull_vba_modules(xlsm.to_string_lossy().into_owned()).unwrap();
    let macros = macros_dir_for(&xlsm).unwrap();
    fs::write(macros.join("Module1.bas"), "Attribute VB_Name = \"Module1\"\r\nSub Hello()\r\nMsgBox 1\r\nEnd Sub\r\n").unwrap();
    fs::write(macros.join("New1.bas"), "Attribute VB_Name = \"New1\"\r\nSub X()\r\nEnd Sub\r\n").unwrap();
    let before = fs::read(&xlsm).unwrap();
    let plan = plan_push(&before, &macros).unwrap();
    assert_eq!(plan.changes.updated.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), vec!["Module1"]);
    assert_eq!(plan.changes.added.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), vec!["New1"]);
    assert!(plan.changes.removed.is_empty());
    assert_eq!(plan.unchanged, vec!["Class1".to_string(), "ThisWorkbook".to_string()]);
    assert!(plan.after.iter().any(|m| m.name == "New1"));
    assert!(plan.before.iter().all(|m| m.name != "New1"));
    assert_eq!(fs::read(&xlsm).unwrap(), before, "plan_push must not write the workbook");
}

#[test]
fn apply_changes_then_project_sources_round_trips() {
    let dir = ...; let xlsm = three_module_workbook(dir.path());
    let data = fs::read(&xlsm).unwrap();
    let out = add_module(&data, "Shim1", ModuleKind::Standard, "Attribute VB_Name = \"Shim1\"\r\nPublic Function F() As Long\r\nF = 1\r\nEnd Function\r\n").unwrap();
    let names: Vec<String> = project_sources(&out).unwrap().into_iter().map(|m| m.name).collect();
    assert!(names.contains(&"Shim1".to_string()));
    assert_eq!(fs::read(&xlsm).unwrap(), data);
}

#[test]
fn push_result_serializes_empty_warnings() {
    // push of an unchanged folder → warnings: []
    let dir = ...; let xlsm = three_module_workbook(dir.path());
    pull_vba_modules(...).unwrap();
    let r = push_vba_modules_impl(xlsm.to_str().unwrap()).unwrap();
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["warnings"], serde_json::json!([]));
}

#[test]
fn workbook_key_lowercases_and_normalizes_separators() {
    assert_eq!(workbook_key("C:\\Work\\Book.XLSM"), "c:/work/book.xlsm");
}
```

- [ ] **Step 2: Run** `cd src-tauri && cargo test --lib vba::tests` → FAIL (missing symbols).

- [ ] **Step 3: Implement.** Move the body of `push_vba_modules_impl` between "collect files" and "write" into `plan_push` (it must take `xlsm_data: &[u8]`; replace `read_vba_project_bin(path)` with `vba_project_bin_from_zip(data)` built on `zip::ZipArchive::new(Cursor::new(data))`). Move the "write" section (stream updates, dir/PROJECT/PROJECTwm, cache invalidation, `replace_zip_entry`) into `apply_changes`, which re-`load_project`s the bytes and resolves `updated`/`removed` names to `ProjectModule`s (unknown names → `vba_error("push_failed", ...)`). `plan_push` keeps every existing validation and error code (`duplicate_module_file`, `invalid_module_name`, `unencodable_character`) and additionally fills `before` / `after`. `add_module` = `normalize_source` + `apply_changes` with one `added` entry (`private` = class && !is_exposed). `push_vba_modules_impl` becomes checks + read + plan + (empty → result) or (backup + apply + write). `project_sources` reuses `load_project` + `module_source` + `fix_vb_name`, skipping `ModuleKind::Form`.

- [ ] **Step 4: Run** `cargo test --lib vba::` → all existing push/pull tests and the new ones PASS.

- [ ] **Step 5: Commit** `refactor(vba): split push into plan_push and apply_changes`

---

### Task 2: Lint, side-effect scan and procedure lookup (`vba_lint.rs`)

**Files:**
- Create: `src-tauri/src/commands/vba_lint.rs`
- Modify: `src-tauri/src/commands/mod.rs` (add `pub mod vba_lint;`), `src-tauri/src/commands/vba.rs` (`plan_push` fills `warnings`)

**Interfaces:**
- Consumes: `ModuleSource`, `PushWarning` from Task 1.
- Produces:
```rust
pub fn count_on_error_resume_next(source: &str) -> usize;         // lines matching (?i)^\s*On\s+Error\s+Resume\s+Next\b, comment lines (' or Rem) excluded
pub fn public_procedure_names(source: &str) -> Vec<String>;        // non-Private Sub/Function/Property Get|Let|Set names, first spelling, dedup case-insensitively
pub fn lint_changes(before: &[ModuleSource], after: &[ModuleSource], touched: &[String]) -> Vec<PushWarning>;
#[derive(Serialize, Debug, Clone, PartialEq)] #[serde(rename_all = "camelCase")]
pub struct SideEffectHit { pub module: String, pub line: usize, pub text: String }   // text = trimmed source line
pub fn scan_side_effects(modules: &[ModuleSource]) -> Vec<SideEffectHit>;            // comment lines excluded; sorted by (module, line)
pub fn side_effects_fingerprint(hits: &[SideEffectHit]) -> String;                   // sha2-256 hex of "module:line:text\n" joined in order
pub fn resolve_macro(modules: &[ModuleSource], spec: &str) -> Result<(String, String), String>; // ("Module1","Main"); Err text lists candidates
pub fn has_procedure(modules: &[ModuleSource], name: &str) -> bool;                  // any Sub/Function (public or private) named `name`, case-insensitive
```
- Procedure regex: `(?im)^\s*(?:(Public|Private|Friend)\s+)?(?:Static\s+)?(?:Sub|Function|Property\s+(?:Get|Let|Set))\s+([A-Za-z_][A-Za-z0-9_]*)`.
- Side-effect patterns (all `(?i)`, applied to non-comment lines): `\bKill\b`, `\bRmDir\b`, `\bMkDir\b`, `\bFileCopy\b`, `^\s*Name\s+\S.*\s+As\s+`, `\bOpen\s+.+\s+For\s+(Output|Append|Binary|Random)\b`, `FileSystemObject`, `\bShell\s*\(`, `\bCreateObject\s*\(`, `\bGetObject\s*\(`, `WScript\.Shell`, `MSXML2`, `WinHttp`, `Outlook\.Application`, `\.SendMail\b`, `URLDownloadToFile`, `Workbooks\.Open\b`, `\.SaveAs\b`, `\.SaveCopyAs\b`, `^\s*(?:Public\s+|Private\s+)?Declare\s+`.
- `lint_changes`: for each module in `after` whose name is in `touched`: `before_count` = count in `before` (0 if absent), `after_count` = count in `after`; emit `OnErrorResumeNextAdded` when `after_count > before_count`. Then over `after` standard modules only: group `public_procedure_names` by lowercase name; emit `DuplicateProcedure { name, modules (sorted) }` when ≥2 modules and at least one of them is in `touched`.
- `plan_push` calls `lint_changes(&before, &after, &touched)` with `touched` = updated ∪ added names.

- [ ] **Step 1: Write failing tests** (in `vba_lint.rs` `mod tests`):

```rust
fn m(name: &str, src: &str) -> ModuleSource { ModuleSource { name: name.into(), kind: ModuleKind::Standard, source: src.into() } }

#[test] fn counts_on_error_resume_next_ignoring_comments() {
    assert_eq!(count_on_error_resume_next("On Error Resume Next\r\n' On Error Resume Next\r\n  on error resume next\r\n"), 2);
}
#[test] fn lists_public_procedures_only() {
    let names = public_procedure_names("Private Sub A()\r\nEnd Sub\r\nPublic Function B() As Long\r\nEnd Function\r\nSub C()\r\nEnd Sub\r\nProperty Get D() As Long\r\nEnd Property\r\nFriend Sub E()\r\nEnd Sub\r\n");
    assert_eq!(names, vec!["B", "C", "D", "E"]);
}
#[test] fn warns_when_resume_next_count_grows_in_touched_module() {
    let before = vec![m("Module1", "Sub A()\r\nEnd Sub\r\n")];
    let after = vec![m("Module1", "Sub A()\r\nOn Error Resume Next\r\nEnd Sub\r\n")];
    assert_eq!(lint_changes(&before, &after, &["Module1".into()]), vec![PushWarning::OnErrorResumeNextAdded { module: "Module1".into(), before: 0, after: 1 }]);
}
#[test] fn no_warning_when_untouched_module_already_had_resume_next() { /* touched = [] → empty */ }
#[test] fn warns_on_duplicate_public_procedure_across_standard_modules_when_one_is_touched() {
    let after = vec![m("Module1", "Sub TrimAll()\r\nEnd Sub\r\n"), m("Utils", "Public Sub trimall()\r\nEnd Sub\r\n")];
    let w = lint_changes(&after, &after, &["Utils".into()]);
    assert_eq!(w, vec![PushWarning::DuplicateProcedure { name: "TrimAll".into(), modules: vec!["Module1".into(), "Utils".into()] }]);
}
#[test] fn class_modules_are_not_checked_for_duplicates() { /* two Class modules with Class_Initialize, touched both → empty */ }
#[test] fn scans_side_effects_and_skips_comments_and_input_opens() {
    let hits = scan_side_effects(&[m("Module1", "Sub A()\r\n' Kill x\r\nKill \"a.txt\"\r\nOpen f For Input As #1\r\nOpen g For Output As #2\r\nSet fso = CreateObject(\"Scripting.FileSystemObject\")\r\nEnd Sub\r\n")]);
    assert_eq!(hits.iter().map(|h| h.line).collect::<Vec<_>>(), vec![3, 5, 6]);
    assert_eq!(hits[0].text, "Kill \"a.txt\"");
}
#[test] fn fingerprint_is_stable_and_changes_with_hits() { /* same hits → same hex; extra hit → different */ }
#[test] fn resolve_macro_accepts_qualified_and_unqualified_names() {
    let mods = vec![m("Module1", "Sub Main()\r\nEnd Sub\r\n"), m("Utils", "Sub Helper()\r\nEnd Sub\r\n")];
    assert_eq!(resolve_macro(&mods, "Module1.Main").unwrap(), ("Module1".into(), "Main".into()));
    assert_eq!(resolve_macro(&mods, "helper").unwrap(), ("Utils".into(), "Helper".into()));
    assert!(resolve_macro(&mods, "Nope").is_err());
    assert!(resolve_macro(&mods, "Utils.Main").is_err());
}
#[test] fn resolve_macro_rejects_ambiguous_unqualified_name() {
    let mods = vec![m("Module1", "Sub Helper()\r\nEnd Sub\r\n"), m("Utils", "Sub Helper()\r\nEnd Sub\r\n")];
    let e = resolve_macro(&mods, "Helper").unwrap_err();
    assert!(e.contains("Module1.Helper") && e.contains("Utils.Helper"));
}
#[test] fn has_procedure_sees_private_ones() { assert!(has_procedure(&[m("A", "Private Function MsgBox()\r\nEnd Function\r\n")], "msgbox")); }
```
Plus in `vba.rs` tests: `push_reports_resume_next_warning` — pull, append `On Error Resume Next` to `Module1.bas`, push → `result.warnings.len() == 1`.

- [ ] **Step 2: Run** `cargo test --lib vba_lint` → FAIL.
- [ ] **Step 3: Implement** `vba_lint.rs` with `regex` (compile once via `std::sync::OnceLock`). Wire into `plan_push`.
- [ ] **Step 4: Run** `cargo test --lib vba` → PASS.
- [ ] **Step 5: Commit** `feat(vba): lint pushes for On Error Resume Next and duplicate procedures; add side-effect scan`

---

### Task 3: Shim generation (`vba_shim.rs`)

**Files:**
- Create: `src-tauri/src/commands/vba_shim.rs`; add to `mod.rs`.

**Interfaces:**
```rust
pub const SHIM_MODULE_NAME: &str = "MdiumShim";
#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq)] #[serde(rename_all = "lowercase")]
pub enum MsgBoxResponse { Ok, Cancel, Abort, Retry, Ignore, Yes, No }
impl MsgBoxResponse { pub fn vb_value(self) -> u8 /* vbOK=1,vbCancel=2,vbAbort=3,vbRetry=4,vbIgnore=5,vbYes=6,vbNo=7 */ }
#[derive(Debug, Clone)]
pub struct MacroCall { pub module: String, pub proc: String, pub args: Vec<serde_json::Value> }
#[derive(Debug, Clone, Default)]
pub struct ShimSpec { pub macros: Vec<MacroCall>, pub inputs: Vec<String>, pub msgbox_responses: Vec<MsgBoxResponse> }
pub fn vba_string_literal(s: &str) -> String;                    // "abc" → "\"abc\""; inner " doubled; \r\n / \n / \r → `" & vbCrLf & "` / vbLf / vbCr
pub fn vba_arg_literal(v: &serde_json::Value) -> Result<String, String>; // String → literal, Number → as written (integers without .0), Bool → True/False, else Err("unsupported argument type")
pub fn render_shim(spec: &ShimSpec) -> String;                   // full module text, CRLF, first line Attribute VB_Name = "MdiumShim"
pub const FIELD_SEP: char = '\u{1f}'; pub const RECORD_SEP: char = '\u{1e}';
```
The generated VBA (fixed shape; the implementer writes helper bodies):
- `Option Explicit`; `Private mLog As String`, `Private mInputIdx As Long`, `Private mMsgIdx As Long`.
- `Private Function Inputs() As Variant` → `Inputs = Array(<literals>)` (or `Array()`); `Private Function MsgResponses() As Variant` → `Array(<vb_values>)`.
- `Private Sub Append(ParamArray f() As Variant)` → joins fields with `Chr(31)`, records with `Chr(30)`.
- `Private Function DefaultButton(ByVal Buttons As Long) As Long` → `Select Case (Buttons And 15)`: 0→1, 1→1, 2→3, 3→6, 4→6, 5→4, Else→1.
- `Public Function MsgBox(Prompt, Optional Buttons As VbMsgBoxStyle = vbOKOnly, Optional Title, Optional HelpFile, Optional Context) As VbMsgBoxResult`: `r` = next of `MsgResponses()` if `mMsgIdx <= UBound`, else `DefaultButton(Buttons)`; `Append "msgbox", CStr(Prompt), CStr(Title & ""), CStr(r)`.
- `Public Function InputBox(Prompt, Optional Title, Optional Default, Optional XPos, Optional YPos, Optional HelpFile, Optional Context) As String`: next of `Inputs()` else `CStr(Default & "")` with `exhausted`; `Append "inputbox", CStr(Prompt), CStr(Title & ""), s, IIf(exhausted, "exhausted", "")`.
- `Public Function MdiumTakeLog() As String` → returns and clears `mLog`.
- For i in 1..=n: `Public Function MdiumRun{i}() As String` with `On Error GoTo Fail`, `Dim t0 As Single: t0 = Timer`, `Call {module}.{proc}` (`({args})` when args non-empty), success `"ok" & Chr(31) & CStr(Int((Timer - t0) * 1000)) & Chr(31) & MdiumTakeLog()`, `Fail:` → `"error" & Chr(31) & CStr(Err.Number) & Chr(31) & Err.Source & Chr(31) & Err.Description & Chr(31) & MdiumTakeLog()`.

- [ ] **Step 1: Failing tests**
```rust
#[test] fn string_literal_doubles_quotes_and_splits_newlines() {
    assert_eq!(vba_string_literal("a\"b"), "\"a\"\"b\"");
    assert_eq!(vba_string_literal("x\r\ny"), "\"x\" & vbCrLf & \"y\"");
}
#[test] fn arg_literals_cover_json_scalars() {
    assert_eq!(vba_arg_literal(&json!("Sheet1")).unwrap(), "\"Sheet1\"");
    assert_eq!(vba_arg_literal(&json!(10)).unwrap(), "10");
    assert_eq!(vba_arg_literal(&json!(2.5)).unwrap(), "2.5");
    assert_eq!(vba_arg_literal(&json!(true)).unwrap(), "True");
    assert!(vba_arg_literal(&json!([1])).is_err());
}
#[test] fn render_shim_declares_shadows_and_one_wrapper_per_macro() {
    let s = render_shim(&ShimSpec { macros: vec![MacroCall { module: "Module1".into(), proc: "Main".into(), args: vec![] }, MacroCall { module: "Module1".into(), proc: "Fill".into(), args: vec![json!("Sheet1"), json!(10)] }], inputs: vec!["42".into(), "東京".into()], msgbox_responses: vec![MsgBoxResponse::Yes] });
    assert!(s.starts_with("Attribute VB_Name = \"MdiumShim\"\r\n"));
    for needle in ["Option Explicit", "Public Function MsgBox(Prompt, Optional Buttons As VbMsgBoxStyle = vbOKOnly", "Public Function InputBox(Prompt, Optional Title, Optional Default", "Public Function MdiumTakeLog() As String", "Public Function MdiumRun1() As String", "Public Function MdiumRun2() As String", "Call Module1.Main\r\n", "Call Module1.Fill(\"Sheet1\", 10)", "Array(\"42\", \"東京\")", "Array(6)", "On Error GoTo Fail", "Chr(31)", "Chr(30)"] { assert!(s.contains(needle), "{needle}"); }
    assert!(!s.contains("MdiumRun3"));
    assert!(!s.contains('\n') || s.matches("\r\n").count() == s.matches('\n').count(), "CRLF only");
}
#[test] fn render_shim_with_no_macros_still_has_take_log() { /* macros empty → no MdiumRun1, has MdiumTakeLog, Array() */ }
#[test] fn default_button_table_is_rendered() { /* contains "Case 0, 1" ... "= 1", "Case 2" → 3, "Case 3, 4" → 6, "Case 5" → 4 */ }
```
- [ ] **Step 2: Run** `cargo test --lib vba_shim` → FAIL. **Step 3: Implement.** **Step 4: PASS.**
- [ ] **Step 5: Commit** `feat(vba): generate the MdiumShim test harness module`

---

### Task 4: `xlsx_read` (calamine) and `/xlsx/read` route

**Files:**
- Modify: `src-tauri/Cargo.toml` (add `calamine = "0.26"` or the current 0.2x; features default)
- Create: `src-tauri/src/commands/xlsx_read.rs`; add to `mod.rs`
- Create fixture: `src-tauri/tests/fixtures/xlsx/read_sample.xlsx` (generated once with SheetJS, see Step 1)
- Modify: `src-tauri/src/http_bridge.rs` (route), `src-tauri/src/lib.rs` (no new command; bridge only)

**Interfaces:**
```rust
#[derive(Deserialize, Debug, Clone)] pub struct RangeSpec { pub sheet: String, #[serde(default)] pub range: Option<String> }
#[derive(Serialize, Debug, Clone, PartialEq)] pub struct CellBlock { pub sheet: String, pub range: String, pub values: Vec<Vec<serde_json::Value>> }
pub const MAX_READ_CELLS: usize = 20_000;
pub fn parse_a1_range(s: &str) -> Result<((u32, u32), (u32, u32)), String>;  // zero-based (row, col) inclusive; "A1" alone = single cell; Err on garbage
pub fn col_label(col: u32) -> String;                                         // 0 → "A", 26 → "AA"
pub fn a1_of(range: ((u32, u32), (u32, u32))) -> String;                      // "A1:C10"
pub fn cell_error_label(com_code: i64) -> Option<&'static str>;               // -2146826288 #NULL!, -2146826281 #DIV/0!, -2146826273 #VALUE!, -2146826265 #REF!, -2146826259 #NAME?, -2146826252 #NUM!, -2146826246 #N/A
pub fn read_ranges(path: &Path, ranges: &[RangeSpec]) -> Result<Vec<CellBlock>, String>;  // Err = vba_error JSON: invalid_workbook (ext not xlsx/xlsm/xlam or missing), invalid_range, read_failed
```
Value mapping (calamine `Data`): `Empty` → `null`, `Int`/`Float` → number, `String` → string, `Bool` → bool, `DateTime(dt)` → `dt.as_f64()` serial number, `DateTimeIso`/`DurationIso` → string, `Error(e)` → the label string (`#N/A` etc.). Range omitted → sheet `used range` (calamine range `start()`/`end()`); cell count over `MAX_READ_CELLS` → `invalid_range` with message "range has N cells; the limit is 20000, narrow the range".

Bridge: `"/xlsx/read"` → body `{ "path": String, "ranges": [RangeSpec] }`; path via `resolve_xlsm_path` (it is generic); response `200 { "ok": true, "path", "cells": [...] }` or `vba_error_response("xlsx_read", err)`.

- [ ] **Step 1: Create the fixture** (run from repo root; SheetJS is a dependency):
```bash
node -e "
const X=require('xlsx');const wb=X.utils.book_new();
const ws=X.utils.aoa_to_sheet([['名前','数量',12.5],['a',true,null],[1,2,{t:'n',v:3,f:'A3+B3'}]]);
ws['C4']={t:'n',v:45000,z:'yyyy-mm-dd'}; ws['D1']={t:'e',v:42}; ws['D2']={t:'e',v:7}; ws['!ref']='A1:D4';
X.utils.book_append_sheet(wb,ws,'Sheet1'); X.utils.book_append_sheet(wb,X.utils.aoa_to_sheet([['x']]),'Other');
X.writeFile(wb,'src-tauri/tests/fixtures/xlsx/read_sample.xlsx');"
```
- [ ] **Step 2: Failing tests** in `xlsx_read.rs`:
```rust
fn fixture() -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/xlsx/read_sample.xlsx") }
#[test] fn parses_a1_ranges() {
    assert_eq!(parse_a1_range("A1:C10").unwrap(), ((0, 0), (9, 2)));
    assert_eq!(parse_a1_range("b2").unwrap(), ((1, 1), (1, 1)));
    assert_eq!(parse_a1_range("AA1:AB2").unwrap(), ((0, 26), (1, 27)));
    assert!(parse_a1_range("1A").is_err()); assert!(parse_a1_range("").is_err());
    assert_eq!(a1_of(((0, 0), (9, 2))), "A1:C10");
}
#[test] fn maps_com_error_codes() { assert_eq!(cell_error_label(-2146826246), Some("#N/A")); assert_eq!(cell_error_label(-2146826281), Some("#DIV/0!")); assert_eq!(cell_error_label(5), None); }
#[test] fn reads_values_with_types_dates_and_errors() {
    let b = read_ranges(&fixture(), &[RangeSpec { sheet: "Sheet1".into(), range: Some("A1:D4".into()) }]).unwrap();
    assert_eq!(b[0].range, "A1:D4");
    assert_eq!(b[0].values[0], vec![json!("名前"), json!("数量"), json!(12.5), json!("#N/A")]);
    assert_eq!(b[0].values[1][1], json!(true)); assert_eq!(b[0].values[1][2], json!(null)); assert_eq!(b[0].values[1][3], json!("#DIV/0!"));
    assert_eq!(b[0].values[2][2], json!(3.0));
    assert_eq!(b[0].values[3][2], json!(45000.0));
}
#[test] fn omitted_range_reads_the_used_range() { /* sheet Other → range "A1", values [["x"]] */ }
#[test] fn unknown_sheet_and_oversized_range_are_invalid_range() { /* "Nope" → invalid_range; "A1:ZZ1000" (702*1000 cells) → invalid_range with "20000" in message */ }
#[test] fn non_workbook_extension_is_invalid_workbook() { /* .txt → invalid_workbook */ }
```
And in `http_bridge.rs` tests: `status_for_vba_error("invalid_range") == 400` (already by default rule; just add to `status_codes_follow_error_code`).
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement** (`calamine::open_workbook_auto`, `worksheet_range`, iterate `range.get((r, c))` relative to `range.start()`). Add bridge route. **Step 5: PASS.**
- [ ] **Step 6: Commit** `feat(bridge): add /xlsx/read backed by calamine`

---

### Task 5: `vba_run.rs` core: types, state, run copies, protocol parsing

**Files:**
- Create: `src-tauri/src/commands/vba_run.rs`; add to `mod.rs`

**Interfaces:**
```rust
pub const VBA_RUN_BUDGET: u32 = 6; pub const RUN_COPY_KEEP: usize = 5;
pub const DEFAULT_TIMEOUT_MS: u64 = 120_000; pub const MAX_TIMEOUT_MS: u64 = 300_000; pub const APPROVAL_TIMEOUT_MS: u64 = 120_000; pub const WATCH_INTERVAL_MS: u64 = 250;

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Serialize)] #[serde(rename_all = "snake_case")]
pub enum RunSource { MacrosDir, Workbook }   impl Default → MacrosDir
#[derive(Deserialize, Debug, Clone)] pub struct MacroSpec { pub name: String, #[serde(default)] pub args: Vec<serde_json::Value> }
#[derive(Deserialize, Debug, Clone)]
pub struct RunRequest { pub xlsm_path: String, #[serde(default)] pub source: RunSource, #[serde(default)] pub macros: Vec<MacroSpec>, #[serde(default)] pub inputs: Vec<String>, #[serde(default)] pub msgbox_responses: Vec<MsgBoxResponse>, #[serde(default)] pub read: Vec<RangeSpec>, #[serde(default)] pub allow_side_effects: bool, #[serde(default)] pub timeout_ms: Option<u64> }
impl RunRequest { pub fn effective_timeout_ms(&self) -> u64 /* default 120000, clamp to 1..=300000 */ }

#[derive(Serialize, Debug, Clone, PartialEq)] #[serde(tag = "kind", rename_all = "lowercase")]
pub enum DialogRecord {
    Msgbox { prompt: String, title: String, response: String },
    Inputbox { prompt: String, title: String, response: String, exhausted: bool },
    Window { class: String, title: String, text: String, clicked: Option<String> },
}
#[derive(Serialize, Debug, Clone, Copy, PartialEq)] #[serde(rename_all = "snake_case")]
pub enum MacroStatus { Ok, Error, DialogInterrupted, Timeout, NotRun }
#[derive(Serialize, Debug, Clone, Copy, PartialEq)] #[serde(rename_all = "lowercase")] pub enum ErrorFrom { Handler, Dialog }
#[derive(Serialize, Debug, Clone, PartialEq)] pub struct MacroError { pub number: i64, pub source: Option<String>, pub description: String, pub from: ErrorFrom }
#[derive(Serialize, Debug, Clone, PartialEq)] #[serde(rename_all = "camelCase")]
pub struct MacroResult { #[serde(rename = "macro")] pub macro_name: String, pub status: MacroStatus, pub duration_ms: Option<u64>, pub error: Option<MacroError>, pub dialogs: Vec<DialogRecord> }
#[derive(Serialize, Debug, Clone, PartialEq)] pub struct BudgetInfo { pub used: u32, pub limit: u32 }
#[derive(Serialize, Debug, Clone)] #[serde(rename_all = "camelCase")]
pub struct RunResult { pub ok: bool, pub run_copy_path: String, pub source: RunSource, pub warnings: Vec<PushWarning>, pub open_dialogs: Vec<DialogRecord>, pub results: Vec<MacroResult>, pub cells: Vec<CellBlock>, pub run_budget: BudgetInfo, pub notes: Vec<String> }
// notes (agent-facing English, exact copy): on timeout "Timed out after {timeout_ms} ms; the run copy was not saved." and, when no HWND was received, "No Excel window handle was received; an EXCEL.EXE process may still be running."

// ---- state (managed by Tauri as VbaRunShared) ----
pub struct VbaRunState { budget: HashMap<String, u32>, approvals: HashSet<(String, String)>, in_progress: HashSet<String>, pub pending_approvals: HashMap<String, std::sync::mpsc::Sender<bool>> }
pub type VbaRunShared = Arc<Mutex<VbaRunState>>;
pub fn new_vba_run_state() -> VbaRunShared;
impl VbaRunState {
    pub fn check_budget(&self, key: &str) -> Result<(), String>;       // Err = vba_error("run_budget_exhausted", "...report to the user...; the budget resets when the user sends the next instruction")
    pub fn consume(&mut self, key: &str) -> BudgetInfo;
    pub fn reset(&mut self, key: &str);                                 // clears budget AND approvals of key
    pub fn is_approved(&self, key: &str, fingerprint: &str) -> bool;
    pub fn approve(&mut self, key: &str, fingerprint: &str);
    pub fn begin(&mut self, key: &str) -> Result<(), String>;           // Err = vba_error("run_in_progress", ...)
    pub fn end(&mut self, key: &str);
}

// ---- run copies ----
pub fn runs_dir_for(xlsm_path: &Path) -> Result<PathBuf, String>;        // <stem>_assets/runs (sibling of macros_dir_for)
pub fn run_dir_name(now: chrono::NaiveDateTime, first_macro: Option<&str>) -> String;  // "20261021-143012_Main" / "20261021-143012_read"; macro = proc part after the last '.', sanitized to [A-Za-z0-9_]
pub fn new_run_dir(runs_dir: &Path, base_name: &str) -> Result<PathBuf, String>;       // creates dir; on collision tries "<base>-2", "-3", ...
pub fn prune_run_dirs(runs_dir: &Path, keep: usize) -> Result<Vec<PathBuf>, String>;  // removes oldest by name (lexicographic), returns removed

// ---- runner stdout protocol ----
#[derive(Debug, Clone, PartialEq)]
pub enum RunnerEvent { Hwnd(isize), OpenLog(String), Result { index: usize, payload: String }, RunExc { index: usize, message: String }, Cells { index: usize, address: String, json: serde_json::Value } }
pub fn parse_runner_line(line: &str) -> Option<RunnerEvent>;            // "HWND 1234", "OPENLOG <b64>", "RESULT 1 <b64>", "RUNEXC 1 <b64>", "CELLS 0 A1:C3 <b64 json>"; anything else None
pub fn parse_dialog_log(log: &str) -> Vec<DialogRecord>;                // records split by '\u{1e}', fields by '\u{1f}'
pub enum ShimOutcome { Ok { duration_ms: u64, dialogs: Vec<DialogRecord> }, Error { error: MacroError /* from Handler */, dialogs: Vec<DialogRecord> }, Empty }
pub fn parse_shim_payload(payload: &str) -> ShimOutcome;               // "" → Empty
pub fn cells_from_json(sheet: &str, address: &str, v: &serde_json::Value) -> CellBlock;  // scalar → [[x]]; 1-D array → one row; {"err": code} → label via cell_error_label (unknown code → "#ERR")
pub fn parse_vbe_error_text(text: &str) -> Option<(i64, String)>;      // (?s)(?:実行時エラー|Run-time error)\s*'(\d+)'\s*:?\s*(.+) → trimmed description
```

- [ ] **Step 1: Failing tests** (`mod tests` in `vba_run.rs`):
```rust
#[test] fn budget_counts_to_limit_and_resets() {
    let mut s = VbaRunState::default(); let k = "c:/w/book.xlsm";
    for i in 1..=VBA_RUN_BUDGET { s.check_budget(k).unwrap(); assert_eq!(s.consume(k), BudgetInfo { used: i, limit: VBA_RUN_BUDGET }); }
    assert_eq!(err_code(&s.check_budget(k).unwrap_err()), "run_budget_exhausted");
    s.approve(k, "fp"); s.reset(k);
    s.check_budget(k).unwrap(); assert!(!s.is_approved(k, "fp"));
}
#[test] fn begin_twice_is_run_in_progress() { /* begin ok, begin → run_in_progress, end, begin ok */ }
#[test] fn effective_timeout_defaults_and_clamps() { /* None → 120000; Some(900000) → 300000; Some(0) → 1 */ }
#[test] fn run_dir_name_uses_proc_part_or_read() {
    let t = chrono::NaiveDate::from_ymd_opt(2026, 10, 21).unwrap().and_hms_opt(14, 30, 12).unwrap();
    assert_eq!(run_dir_name(t, Some("Module1.Main")), "20261021-143012_Main");
    assert_eq!(run_dir_name(t, None), "20261021-143012_read");
}
#[test] fn new_run_dir_appends_suffix_on_collision() { /* create base, then new_run_dir → "<base>-2" exists */ }
#[test] fn prune_keeps_the_newest_five() { /* create 7 dirs named 20260101-000001 .. 07; prune(5) removes 01, 02 */ }
#[test] fn parses_runner_lines() {
    assert_eq!(parse_runner_line("HWND 1234"), Some(RunnerEvent::Hwnd(1234)));
    assert_eq!(parse_runner_line(&format!("RESULT 2 {}", b64("ok\u{1f}12\u{1f}"))), Some(RunnerEvent::Result { index: 2, payload: "ok\u{1f}12\u{1f}".into() }));
    assert!(matches!(parse_runner_line(&format!("CELLS 0 A1:B1 {}", b64("[[1,\"a\"]]"))), Some(RunnerEvent::Cells { index: 0, .. })));
    assert_eq!(parse_runner_line("noise"), None);
}
#[test] fn parses_shim_payloads() {
    let log = "msgbox\u{1f}完了\u{1f}\u{1f}1\u{1e}inputbox\u{1f}件数は?\u{1f}\u{1f}42\u{1f}exhausted";
    match parse_shim_payload(&format!("ok\u{1f}812\u{1f}{log}")) { ShimOutcome::Ok { duration_ms, dialogs } => { assert_eq!(duration_ms, 812); assert_eq!(dialogs, vec![DialogRecord::Msgbox { prompt: "完了".into(), title: "".into(), response: "1".into() }, DialogRecord::Inputbox { prompt: "件数は?".into(), title: "".into(), response: "42".into(), exhausted: true }]); } _ => panic!() }
    match parse_shim_payload("error\u{1f}9\u{1f}VBAProject\u{1f}インデックスが有効範囲にありません。\u{1f}") { ShimOutcome::Error { error, .. } => { assert_eq!(error.number, 9); assert_eq!(error.from, ErrorFrom::Handler); assert_eq!(error.source.as_deref(), Some("VBAProject")); } _ => panic!() }
    assert!(matches!(parse_shim_payload(""), ShimOutcome::Empty));
}
#[test] fn cells_payload_single_value_becomes_one_by_one() {
    assert_eq!(cells_from_json("S", "B2", &json!(5)).values, vec![vec![json!(5)]]);
    assert_eq!(cells_from_json("S", "A1:B1", &json!([[1, {"err": -2146826246}]])).values, vec![vec![json!(1), json!("#N/A")]]);
}
#[test] fn parses_vbe_error_text_in_japanese_and_english() {
    assert_eq!(parse_vbe_error_text("実行時エラー '9':\r\n\r\nインデックスが有効範囲にありません。"), Some((9, "インデックスが有効範囲にありません。".into())));
    assert_eq!(parse_vbe_error_text("Run-time error '1004':\r\nApplication-defined error"), Some((1004, "Application-defined error".into())));
    assert_eq!(parse_vbe_error_text("完了しました"), None);
}
#[test] fn result_serializes_with_spec_field_names() {
    let v = serde_json::to_value(MacroResult { macro_name: "Module1.Main".into(), status: MacroStatus::DialogInterrupted, duration_ms: None, error: None, dialogs: vec![DialogRecord::Window { class: "#32770".into(), title: "t".into(), text: "x".into(), clicked: Some("終了".into()) }] }).unwrap();
    assert_eq!(v["macro"], "Module1.Main"); assert_eq!(v["status"], "dialog_interrupted"); assert_eq!(v["dialogs"][0]["kind"], "window");
}
```
- [ ] **Step 2: Run** `cargo test --lib vba_run` → FAIL. **Step 3: Implement** (pure code, no Excel). **Step 4: PASS.**
- [ ] **Step 5: Commit** `feat(vba): vba_run core types, run budget, run-copy folders and runner protocol`

---

### Task 6: Dialog watch (Win32)

**Files:**
- Modify: `src-tauri/Cargo.toml` → `[target.'cfg(windows)'.dependencies] windows-sys = { version = "0.59", features = ["Win32_Foundation", "Win32_UI_WindowsAndMessaging", "Win32_System_Threading", "Win32_UI_Input_KeyboardAndMouse"] }` (use the current 0.5x; drop features the compiler reports unused)
- Create: `src-tauri/src/commands/vba_dialog_watch.rs`; add to `mod.rs`

**Interfaces:**
```rust
pub const BUTTON_PREFERENCE: [&str; 7] = ["終了", "End", "キャンセル", "Cancel", "いいえ", "No", "OK"];
pub const CANCEL_PREFERENCE: [&str; 2] = ["キャンセル", "Cancel"];
pub fn pick_button<'a>(labels: &'a [String], prefs: &[&str]) -> Option<&'a String>;  // first pref that matches a label after stripping '&' and trailing "(&X)" mnemonics, case-insensitive
pub fn dismiss_plan(class: &str, labels: &[String]) -> Dismiss;   // pure: "#32770" → Click(pick BUTTON_PREFERENCE) else Close; "bosa_sdm_XL9" → Click(pick CANCEL_PREFERENCE) else Close; "XLMAIN" → Skip; others → Close
pub enum Dismiss { Click(String), Close, Skip }
pub fn pid_of_window(hwnd: isize) -> Option<u32>;          // GetWindowThreadProcessId
pub fn scan_and_dismiss(pid: u32) -> Vec<DialogRecord>;    // visible top-level windows of pid (EnumWindows + IsWindowVisible), per dismiss_plan; text = child "Static" texts joined by "\n"; Click → WM_COMMAND(MAKEWPARAM(GetDlgCtrlID(btn), BN_CLICKED), btn hwnd) sent to the dialog; Close → PostMessage WM_CLOSE
pub fn terminate_process(pid: u32) -> bool;                // OpenProcess(PROCESS_TERMINATE) + TerminateProcess
```
Non-windows: `pid_of_window` → `None`, `scan_and_dismiss` → `vec![]`, `terminate_process` → `false`. `pick_button` / `dismiss_plan` compile everywhere and are unit-tested.

- [ ] **Step 1: Failing tests** (`vba_dialog_watch.rs`):
```rust
#[test] fn picks_the_most_preferred_button_ignoring_mnemonics() {
    let labels = vec!["継続(&C)".to_string(), "終了(&E)".to_string(), "デバッグ(&D)".to_string(), "ヘルプ(&H)".to_string()];
    assert_eq!(pick_button(&labels, &BUTTON_PREFERENCE).unwrap(), "終了(&E)");
    assert_eq!(pick_button(&["&Yes".to_string(), "&No".to_string()], &BUTTON_PREFERENCE).unwrap(), "&No");
    assert!(pick_button(&["Retry".to_string()], &BUTTON_PREFERENCE).is_none());
}
#[test] fn dismiss_plan_follows_class_table() {
    assert!(matches!(dismiss_plan("#32770", &["OK".into()]), Dismiss::Click(ref l) if l == "OK"));
    assert!(matches!(dismiss_plan("#32770", &[]), Dismiss::Close));
    assert!(matches!(dismiss_plan("bosa_sdm_XL9", &["OK".into(), "キャンセル".into()]), Dismiss::Click(ref l) if l == "キャンセル"));
    assert!(matches!(dismiss_plan("ThunderDFrame", &["OK".into()]), Dismiss::Close));
    assert!(matches!(dismiss_plan("XLMAIN", &[]), Dismiss::Skip));
}
```
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (unsafe Win32 confined to this file; `EnumWindows` callback collects `(hwnd, class, title)` for `pid` into a `Vec` via `LPARAM` pointer). **Step 4:** `cargo test --lib vba_dialog_watch` PASS and `cargo build` succeeds on Windows.
- [ ] **Step 5: Commit** `feat(vba): Win32 dialog watch for hidden Excel runs`

---

### Task 7: Orchestration, PowerShell runner, approval relay, bridge route, registration

**Files:**
- Modify: `src-tauri/src/commands/vba_run.rs` (orchestration + commands), `src-tauri/src/http_bridge.rs` (route `/vba/run`, status codes), `src-tauri/src/lib.rs` (manage `VbaRunShared`, register `reset_vba_run_budget`, `vba_run_approval_reply`)

**Interfaces:**
```rust
// vba_run.rs
pub fn run_vba_macros(app: &AppHandle, state: &VbaRunShared, req: &RunRequest, resolved_path: &str) -> Result<RunResult, String>;  // Err = vba_error JSON
#[tauri::command] pub fn reset_vba_run_budget(state: tauri::State<VbaRunShared>, xlsm_path: String) -> Result<(), String>;   // state.reset(&workbook_key(&xlsm_path))
#[tauri::command] pub fn vba_run_approval_reply(state: tauri::State<VbaRunShared>, id: String, granted: bool) -> Result<(), String>; // like rag_bridge_respond; unknown id → Err
pub const RUNNER_SCRIPT: &str = r#"..."#;   // see below
pub struct RunnerOutcome { pub events: Vec<RunnerEvent>, pub windows: Vec<(usize /*phase: 0 = open, i = macro i*/, DialogRecord)>, pub timed_out: bool, pub exit_code: Option<i32>, pub stderr: String, pub excel_pid: Option<u32>, pub excel_left_running: bool }
pub fn spawn_and_watch(copy_path: &Path, macro_count: usize, read: &[RangeSpec], timeout_ms: u64) -> Result<RunnerOutcome, String>;  // cfg(windows); other OS → Err(vba_error("excel_not_available", ...))
pub fn assemble_result(req: &RunRequest, macro_names: &[String], outcome: &RunnerOutcome, run_copy_path: &str, warnings: Vec<PushWarning>, budget: BudgetInfo) -> RunResult;  // pure, unit-tested
```
Approval event (Rust → webview) name `vba-run-approval-request`, payload `{ "id": String, "xlsmPath": String, "macros": [String], "matches": [SideEffectHit] }`.

`run_vba_macros` steps (spec 3.2): `key = workbook_key(path)`; `state.check_budget`; `state.begin` (always `end` on every exit path); `require_macro_workbook`; `fs::read`; by `source`: `MacrosDir` → `macros_dir_for` must exist (`macros_dir_not_found`) → `plan_push` → `base = if changes.is_empty() { data } else { apply_changes }`, `modules = plan.after`, `warnings = plan.warnings`; `Workbook` → `base = data`, `modules = project_sources`, `warnings = []`. Static checks: `modules` contains `MdiumShim` or `has_procedure(MsgBox|InputBox)` → `shim_name_conflict`; each macro via `resolve_macro` → `macro_not_found`; `scan_side_effects` non-empty → if `!allow_side_effects` → `side_effects_detected` (message lists `module:line: text`, one per line), else fingerprint; if not approved → emit event, wait `APPROVAL_TIMEOUT_MS` on `pending_approvals[id]`; `false` → `approval_denied`; timeout → `approval_timeout`; `true` → `approve`. Shim: `render_shim` → `add_module(&base, SHIM_MODULE_NAME, Standard, &shim)`; `runs_dir_for` + `new_run_dir(run_dir_name(Local::now().naive_local(), first))`; write `<run_dir>/<original file name>`; `prune_run_dirs(RUN_COPY_KEEP)`; `spawn_and_watch`; exit code 2 or stderr containing `EXCEL_NOT_AVAILABLE` → `excel_not_available`; exit code 1 and no `RESULT`/`RUNEXC` events → `run_failed` with first stderr line; else `assemble_result`; `state.consume`.

`assemble_result`: macro `i` (1-based) → by its `Result`/`RunExc` event: `Ok` → `Ok`; `Error` → `Error(handler)`; `Empty`/`RunExc` → if any `Window` dialog in phase `i` has `parse_vbe_error_text` → `Error { from: Dialog, source: None }`, else `DialogInterrupted`; no event and `timed_out` → the first such macro `Timeout`, following `NotRun`; no event otherwise → `NotRun`. `open_dialogs` = `OpenLog` parsed + phase-0 windows. `cells` from `Cells` events in order. `ok` = all `Ok`. `notes` per the RunResult comment (`timed_out` → timeout note; `excel_left_running` → process note).

`spawn_and_watch` (Windows): `Command::new("powershell").args(["-NoProfile","-NonInteractive","-Command", RUNNER_SCRIPT]).env("MDIUM_RUN_COPY", copy).env("MDIUM_RUN_COUNT", n).env("MDIUM_RUN_READ", json).creation_flags(0x08000000).stdout(piped).stderr(piped).spawn()`; a thread reads stdout lines into an `mpsc` channel; loop every `WATCH_INTERVAL_MS`: drain lines (`Hwnd` → `pid_of_window`), phase = number of `Result`/`RunExc` seen + 1 (0 before `OpenLog`), `scan_and_dismiss(pid)` → push `(phase, record)`, `child.try_wait()`, deadline → `terminate_process(pid)` if known else `excel_left_running = true`, `child.kill()`, `timed_out = true`.

`RUNNER_SCRIPT` (single quotes only; `B64` helper; per-macro try/catch; cells mapping):
```powershell
$ErrorActionPreference = 'Stop'
function B64([string]$s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }
function CellVal($v) {
  if ($null -eq $v) { return $null }
  if ($v -is [int]) { return @{ err = [int]$v } }
  return $v
}
try { $xl = New-Object -ComObject Excel.Application } catch { [Console]::Error.WriteLine('EXCEL_NOT_AVAILABLE: ' + $_.Exception.Message); exit 2 }
$code = 0
try {
  $xl.Visible = $false; $xl.DisplayAlerts = $false; $xl.ScreenUpdating = $false; $xl.Interactive = $false
  $xl.AutomationSecurity = 1
  [Console]::Out.WriteLine('HWND ' + $xl.Hwnd)
  $wb = $xl.Workbooks.Open($env:MDIUM_RUN_COPY, 0, $false)
  try {
    [Console]::Out.WriteLine('OPENLOG ' + (B64 ([string]$xl.Run('MdiumShim.MdiumTakeLog'))))
    $n = [int]$env:MDIUM_RUN_COUNT
    for ($i = 1; $i -le $n; $i++) {
      try {
        $r = $xl.Run('MdiumShim.MdiumRun' + $i)
        [Console]::Out.WriteLine('RESULT ' + $i + ' ' + (B64 ([string]$r)))
      } catch {
        [Console]::Out.WriteLine('RUNEXC ' + $i + ' ' + (B64 $_.Exception.Message))
      }
    }
    $reads = @()
    if ($env:MDIUM_RUN_READ) { $reads = @(ConvertFrom-Json $env:MDIUM_RUN_READ) }
    for ($k = 0; $k -lt $reads.Count; $k++) {
      $spec = $reads[$k]
      $ws = $wb.Worksheets.Item($spec.sheet)
      if ($spec.range) { $rng = $ws.Range($spec.range) } else { $rng = $ws.UsedRange }
      $addr = $rng.Address($false, $false)
      $v = $rng.Value2
      $rows = @()
      if ($v -is [Array]) {
        for ($r = 1; $r -le $rng.Rows.Count; $r++) { $row = @(); for ($c = 1; $c -le $rng.Columns.Count; $c++) { $row += ,(CellVal $v[$r, $c]) }; $rows += ,$row }
      } else { $rows = @(,@(,(CellVal $v))) }
      [Console]::Out.WriteLine('CELLS ' + $k + ' ' + $addr + ' ' + (B64 (ConvertTo-Json -InputObject $rows -Depth 5 -Compress)))
    }
    $wb.Save()
  } finally { $wb.Close($false) }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message); $code = 1
} finally {
  $xl.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($xl)
}
exit $code
```
(`ConvertTo-Json` of nested arrays: pass `-InputObject` so single-row arrays are not unrolled; the Rust `cells_from_json` tolerates scalar / 1-D / 2-D anyway.)

Bridge: in `handle_request`, `"/vba/run"` → parse `RunRequest`, resolve `xlsm_path` with `resolve_xlsm_path`, call `run_vba_macros(app, &app.state::<VbaRunShared>(), &req, &path)`, respond `200 result` or `vba_error_response("run", err)`. Add statuses to `status_for_vba_error`.

- [ ] **Step 1: Failing unit tests** (`vba_run.rs`):
```rust
#[test] fn assemble_maps_events_to_statuses() {
    // events: RESULT 1 ok, RUNEXC 2, (none for 3), timed_out = true; phase-2 window with "実行時エラー '1004':\r\nx"
    // → [Ok(duration 812), Error{from: Dialog, number: 1004, description "x"}, Timeout]; ok == false
}
#[test] fn assemble_marks_empty_result_without_error_text_as_dialog_interrupted() { /* RESULT 1 "" + phase-1 window "完了" → DialogInterrupted with that window in dialogs */ }
#[test] fn assemble_puts_open_phase_windows_and_openlog_into_open_dialogs() { ... }
#[test] fn assemble_not_run_without_timeout_when_runner_died() { /* no events, timed_out false → all NotRun */ }
#[test] fn status_codes_for_run_errors() { // in http_bridge.rs tests
    assert_eq!(status_for_vba_error("run_budget_exhausted"), 429); assert_eq!(status_for_vba_error("run_in_progress"), 409);
    assert_eq!(status_for_vba_error("approval_denied"), 403); assert_eq!(status_for_vba_error("approval_timeout"), 408);
}
```
Static-check tests that need no Excel (call a factored `prepare_run(req, data, macros_dir) -> Result<Prepared, String>` where `Prepared { base: Vec<u8>, modules: Vec<ModuleSource>, warnings, macros: Vec<MacroCall>, side_effects: Vec<SideEffectHit> }`; expose it `pub(crate)`):
```rust
#[test] fn prepare_rejects_shim_name_conflicts() { /* workbook with module "MdiumShim" → shim_name_conflict; workbook with "Private Function MsgBox()" → shim_name_conflict */ }
#[test] fn prepare_reports_macro_not_found() { ... }
#[test] fn workbook_source_ignores_macros_dir() { /* pull; edit Module1.bas adding "Sub Added()"; prepare with Workbook → modules lack "Added"; with MacrosDir → has it and warnings from plan */ }
#[test] fn prepare_without_macros_dir_is_macros_dir_not_found_only_for_macros_dir_source() { ... }
```
Ignored Excel tests (names start with `vba_run_excel_`, `#[ignore]`, build the workbook via `add_module` on `three_module_workbook` so no Excel COM VBE access is needed):
```rust
#[test] #[ignore] fn vba_run_excel_msgbox_and_inputbox_complete_without_dialogs() { /* module: Sub Main(): Dim s: s = InputBox("n"): MsgBox "done " & s: Range("A1").Value = CLng(s) * 2 → status ok, dialogs has inputbox+msgbox, cells A1 == 84 for inputs ["42"] */ }
#[test] #[ignore] fn vba_run_excel_unhandled_error_in_standard_module_is_reported_from_handler() { /* Sub Boom(): Dim a(1): a(5) = 1 → Error{number 9, from Handler} */ }
#[test] #[ignore] fn vba_run_excel_qualified_vba_msgbox_is_dismissed_by_the_watch() { /* VBA.MsgBox "hi" → status ok, dialogs has Window{class "#32770", clicked "OK"} */ }
#[test] #[ignore] fn vba_run_excel_timeout_kills_excel() { /* Sub Loop(): Do: DoEvents: Loop; timeout 3000 → Timeout; no EXCEL.EXE with that pid afterwards */ }
```
- [ ] **Step 2: Run** `cargo test --lib vba_run` → FAIL. **Step 3: Implement** orchestration, commands, route, registration (`.manage::<VbaRunShared>(new_vba_run_state())`, add both commands to `generate_handler!`). **Step 4:** `cargo test --lib` PASS; `cargo test --lib -- --ignored vba_run_excel` on this PC (Excel installed) PASS; record the 300 s `timeout_ms` reachability result in the commit message of Task 8 after the tool exists.
- [ ] **Step 5: Commit** `feat(vba): vba_run runs macros on a disposable copy through Excel COM with dialog watch and run budget`

---

### Task 8: opencode tools `vba_run` and `xlsx_read`

**Files:**
- Create: `.opencode/tools/vba_run.ts`, `.opencode/tools/xlsx_read.ts` (copy the bridge-reading boilerplate of `vba_push.ts`; header `// mdium-tool-version: 1`)
- Modify: `src/features/opencode-config/lib/builtin-registry.ts` (imports with `?raw`, two `BUILTIN_CUSTOM_TOOLS` entries)
- Test: `src/features/opencode-config/lib/__tests__/builtin-registry.test.ts`

**Interfaces:**
- `vba_run` args (zod via `tool.schema`): `xlsm_path: string`, `source?: "macros_dir" | "workbook"`, `macros?: { name: string; args?: (string | number | boolean)[] }[]`, `inputs?: string[]`, `msgbox_responses?: ("ok"|"cancel"|"yes"|"no"|"retry"|"ignore"|"abort")[]`, `read?: { sheet: string; range?: string }[]`, `allow_side_effects?: boolean`, `timeout_ms?: number`. POST `/vba/run` with the args as JSON; `signal: AbortSignal.timeout(120_000 + (timeout_ms ?? 120_000) + 15_000)`. Non-OK → `vba_run failed (<error>): <message>`; OK → pretty JSON.
- `xlsx_read` args: `path: string`, `ranges: { sheet: string; range?: string }[]`. POST `/xlsx/read`.
- Descriptions (exact copy):
  - `vba_run`: "Run macros of an .xlsm/.xlam on a disposable copy built from the workbook plus the current <stem>_assets/macros/ sources (source=macros_dir, default) or from the workbook as-is (source=workbook, for a baseline). Excel runs hidden; MsgBox/InputBox are answered from msgbox_responses/inputs; run-time errors are returned per macro; `read` returns cell values (Value2) after the run. Never writes the original workbook. Each call costs 1 of 6 runs per user instruction (run_budget_exhausted); side-effecting code needs allow_side_effects and the user's approval in MDium."
  - `xlsx_read`: "Read saved cell values of an .xlsx/.xlsm/.xlam (no Excel; values as of the last save). Use it on a run copy right after vba_run, or on the original workbook."

- [ ] **Step 1: Failing test** (append to `builtin-registry.test.ts`):
```ts
describe("builtin VBA run tools", () => {
  for (const name of ["vba_run", "xlsx_read"]) {
    it(`registers ${name}`, () => {
      const entry = BUILTIN_CUSTOM_TOOLS[name];
      expect(entry).toBeDefined();
      expect(entry.fileName).toBe(`${name}.ts`);
      expect(entry.content).toContain("mdium-tool-version: 1");
    });
  }
  it("vba_run posts to /vba/run with an abort signal covering approval and run", () => {
    const src = BUILTIN_CUSTOM_TOOLS.vba_run.content;
    expect(src).toContain("/vba/run");
    expect(src).toContain("AbortSignal.timeout(");
    expect(src).toContain("allow_side_effects");
  });
  it("xlsx_read posts to /xlsx/read", () => { expect(BUILTIN_CUSTOM_TOOLS.xlsx_read.content).toContain("/xlsx/read"); });
});
```
- [ ] **Step 2:** `npx vitest run src/features/opencode-config/lib/__tests__/builtin-registry.test.ts` → FAIL. **Step 3: Implement.** **Step 4:** PASS and `npx tsc --noEmit` clean.
- [ ] **Step 5: Manual check** (this PC): with `npm run tauri dev` running and opencode connected, call `vba_run` with `timeout_ms: 300000` on a macro `Do: DoEvents: Loop` and confirm the tool receives the `timeout` result instead of a fetch error; if it does not, lower `MAX_TIMEOUT_MS` in Rust and the spec 4.4 accordingly. Note the outcome in the commit body.
- [ ] **Step 6: Commit** `feat(opencode): add vba_run and xlsx_read tools`

---

### Task 9: Skill `vba-mdium-flow` v4

**Files:**
- Modify: `src/features/opencode-config/lib/builtin-skills.ts` (`vba-mdium-flow`: `version: 4`, description, content)
- Test: `src/features/opencode-config/lib/__tests__/builtin-skills.test.ts`

New description: "Use when editing VBA macros of an .xlsm/.xlam workbook opened in MDium — pull the modules with vba_pull, edit the .bas/.cls files, verify them with vba_run on a disposable copy when the user asked for verification, then write them back with vba_push."

Content changes (keep the existing sections; replace the "Standard flow" and add the new ones):
- Intro: "MDium exposes five tools that operate on a workbook path: `vba_list`, `vba_pull`, `vba_push`, `vba_run`, `xlsx_read`."
- **Standard flow (edit only)**: steps 1–4 as today; step 5: "Report `updated`, `added`, `removed`, `skipped`, `warnings` and `backupPath` to the user. When nothing changed, `backupPath` is null and the workbook was left as it was." Remove "MDium does not run macros".
- **## Run and verify (only when asked)**: "Run macros only when the user's instruction includes running, checking, verifying or testing (e.g. 実行, 確認, 検証, テスト, 動くか見て, 'make sure it works'). If the user asked only for an edit, stop after `vba_push` and report." Then the numbered loop from spec 7.2 (baseline with `source: "workbook"`; edit, do NOT push yet; `vba_run` with target + baseline macros in ONE call and the same `read` ranges; compare with the expectation derived from the instruction and with the baseline; regressions first; at most 3 fix-and-rerun cycles then report and stop with the original untouched; stop immediately on `run_budget_exhausted`; on success `vba_push`; if `workbook_locked`, say the code is verified and wait for the user to close Excel; final report with changes, results, `runCopyPath`, remaining warnings).
- **## Rules while fixing** (spec 7.3, each as a bullet): never adjust the expectation to the code; no `On Error Resume Next` to silence errors, handle `on_error_resume_next_added`; grep the macros folder before adding helpers, resolve `duplicate_procedure`; fix causes not symptoms; run copies live under `<stem>_assets/runs/<time>_<macro>/` with the original file name, so `ThisWorkbook.Path` differs — a failure that only happens on the copy is not a regression; `side_effects_detected` → explain the listed lines and what they could do, then call again with `allow_side_effects: true`; MDium shows the user an approval dialog; `approval_denied` → stop and ask; `approval_timeout` → report and stop, do not retry; choose `inputs` / `msgbox_responses` from the instruction and the code, ask when unsure; a `dialogs` entry of kind `window` with class `ThunderDFrame` means a UserForm — not verifiable automatically, ask the user to check by hand; `Value2` dates are serial numbers, compare numerically; a run copy is NOT a sandbox for file, mail or process side effects.
- **## Reading values**: `read` on `vba_run` (fresh, recalculated), `xlsx_read` for saved values of any workbook or run copy; cell error values come back as `#N/A`, `#DIV/0!`, ….

- [ ] **Step 1: Failing test** (extend `builtin-skills.test.ts`):
```ts
it("vba-mdium-flow v4 teaches the run-and-verify loop", () => {
  const skill = BUILTIN_SKILLS["vba-mdium-flow"];
  expect(skill.version).toBe(4);
  const body = skill.content;
  for (const needle of ["vba_run", "xlsx_read", "source: \"workbook\"", "run_budget_exhausted", "side_effects_detected", "allow_side_effects", "approval_denied", "approval_timeout", "on_error_resume_next_added", "duplicate_procedure", "ThunderDFrame", "runCopyPath", "3 fix-and-rerun"]) {
    expect(body).toContain(needle);
  }
  expect(body).not.toContain("MDium does not run macros");
});
```
- [ ] **Step 2:** run → FAIL. **Step 3: Write the content.** **Step 4:** `npx vitest run src/features/opencode-config/lib/__tests__/builtin-skills.test.ts` PASS.
- [ ] **Step 5: Commit** `feat(opencode): vba-mdium-flow v4 teaches the run-and-verify loop`

---

### Task 10: Side-effect approval dialog in the webview

**Files:**
- Create: `src/features/preview/hooks/useVbaRunApproval.ts`, `src/features/preview/hooks/__tests__/useVbaRunApproval.test.tsx`
- Modify: `src/app/App.tsx` (call `useVbaRunApproval()` right after `useRagBridge()`), `src/shared/i18n/locales/en/editor.json`, `src/shared/i18n/locales/ja/editor.json`

**Interfaces:**
```ts
export interface VbaRunApprovalRequest { id: string; xlsmPath: string; macros: string[]; matches: { module: string; line: number; text: string }[] }
export const VBA_RUN_APPROVAL_TIMEOUT_MS = 120_000;
export const VBA_RUN_APPROVAL_MAX_LINES = 20;
export function formatApprovalMessage(req: VbaRunApprovalRequest, t: TFunction<"editor">): string;  // pure, exported for tests
export function useVbaRunApproval(): void;   // listen("vba-run-approval-request") → showConfirm(message, { title: t("vbaRunApprovalTitle"), kind: "warning", signal: AbortSignal.timeout(VBA_RUN_APPROVAL_TIMEOUT_MS) }) → invoke("vba_run_approval_reply", { id, granted }); errors from invoke are logged, never thrown
```
i18n (`editor` namespace), en:
- `vbaRunApprovalTitle`: "Allow this macro run?"
- `vbaRunApprovalBody`: "{{fileName}} — macros: {{macros}}\nThe code contains calls that can affect things outside the workbook. The run uses a copy of the workbook, but file operations, external processes and network/mail calls really happen.\n\n{{matches}}"
- `vbaRunApprovalMore`: "… and {{count}} more"
ja:
- `vbaRunApprovalTitle`: "マクロの実行を許可しますか？"
- `vbaRunApprovalBody`: "{{fileName}} — マクロ: {{macros}}\nブックの外に影響する可能性のある呼び出しが含まれています。実行はブックのコピー上で行いますが、ファイル操作・外部プロセス・通信やメール送信は実際に行われます。\n\n{{matches}}"
- `vbaRunApprovalMore`: "…他 {{count}} 件"
`matches` = first 20 lines `"<module>:<line>: <text>"` joined by `\n`, then `vbaRunApprovalMore` when more; `fileName` = basename of `xlsmPath`; `macros` = joined with ", ".

- [ ] **Step 1: Failing tests** (`useVbaRunApproval.test.tsx`, `// @vitest-environment happy-dom`, mock `@tauri-apps/api/core` `invoke`, `@tauri-apps/api/event` `listen` capturing the handler, `@/stores/dialog-store` `showConfirm`):
```tsx
it("formats the message with at most 20 match lines and a more-count", () => {
  const matches = Array.from({ length: 23 }, (_, i) => ({ module: "Module1", line: i + 1, text: `Kill ${i}` }));
  const msg = formatApprovalMessage({ id: "1", xlsmPath: "C:/w/Book.xlsm", macros: ["Module1.Main"], matches }, t);
  expect(msg).toContain("Book.xlsm"); expect(msg).toContain("Module1.Main");
  expect(msg).toContain("Module1:20: Kill 19"); expect(msg).not.toContain("Module1:21:"); expect(msg).toContain("3");
});
it("asks with showConfirm and replies granted=true", async () => {
  showConfirm.mockResolvedValue(true);
  renderHook(() => useVbaRunApproval());
  await emit({ id: "req1", xlsmPath: "C:/w/Book.xlsm", macros: ["Main"], matches: [] });
  expect(showConfirm).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ kind: "warning", signal: expect.any(AbortSignal) }));
  expect(invoke).toHaveBeenCalledWith("vba_run_approval_reply", { id: "req1", granted: true });
});
it("replies granted=false when the user declines", async () => { ... });
it("unlistens on unmount", async () => { ... });
```
- [ ] **Step 2:** run → FAIL. **Step 3: Implement** hook + strings + mount. **Step 4:** `npx vitest run src/features/preview/hooks src/shared/i18n` PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(macro-chat): approval dialog for side-effecting macro runs`

---

### Task 11: Run-budget reset on user actions

**Files:**
- Create: `src/features/opencode-config/lib/vba-run-budget.ts`, `src/features/opencode-config/lib/__tests__/vba-run-budget.test.ts`
- Modify: `src/features/opencode-config/hooks/useOpencodeChat.ts` (`doSendMessage` after the empty-text guard; `doAnswerQuestions` after `_pendingQuestionRequestId = null` in the reply branch), `src/features/preview/components/MacroChatPane.tsx` (`handleNewChat`), `src/features/opencode-config/hooks/useOpencodeChat.test.ts`, `src/features/preview/components/MacroChatPane.test.tsx`

**Interfaces:**
```ts
// vba-run-budget.ts
export function workbookForSession(sessionId: string | null, sessionByWorkbook: Record<string, string>): string | null; // the stored (already workbookKey-normalized) key whose value === sessionId
export async function resetVbaRunBudget(xlsmPath: string): Promise<void>;                 // invoke("reset_vba_run_budget", { xlsmPath }); errors logged with console.warn, never thrown
export async function resetVbaRunBudgetForSession(sessionId: string | null): Promise<void>; // looks up useMacroChatStore.getState().sessionByWorkbook; no-op when none
```
Call sites: `doSendMessage` → `await resetVbaRunBudgetForSession(useChatUIStore.getState().currentSessionId)` before `ensureConnectedToActiveFolder()`; `doAnswerQuestions` reply branch → same; `MacroChatPane.handleNewChat` → `await resetVbaRunBudget(filePath)` before `setSession(filePath, null)`.

- [ ] **Step 1: Failing tests**
```ts
// vba-run-budget.test.ts (node env)
it("finds the workbook bound to a session", () => {
  expect(workbookForSession("ses_1", { "c:/w/book.xlsm": "ses_1", "c:/w/other.xlsm": "ses_2" })).toBe("c:/w/book.xlsm");
  expect(workbookForSession("ses_9", { "c:/w/book.xlsm": "ses_1" })).toBeNull();
  expect(workbookForSession(null, { "c:/w/book.xlsm": "ses_1" })).toBeNull();
});
it("resets through the tauri command and swallows errors", async () => {
  invoke.mockRejectedValueOnce(new Error("x"));
  await expect(resetVbaRunBudget("C:/w/Book.xlsm")).resolves.toBeUndefined();
  expect(invoke).toHaveBeenCalledWith("reset_vba_run_budget", { xlsmPath: "C:/w/Book.xlsm" });
});
it("resetVbaRunBudgetForSession uses the macro chat store binding", async () => {
  useMacroChatStore.getState().setSession("C:/w/Book.xlsm", "ses_1");
  await resetVbaRunBudgetForSession("ses_1");
  expect(invoke).toHaveBeenCalledWith("reset_vba_run_budget", { xlsmPath: "c:/w/book.xlsm" });
});
// useOpencodeChat.test.ts
describe("doSendMessage", () => {
  it("resets the run budget of the workbook bound to the current session before sending", async () => {
    useMacroChatStore.getState().setSession("C:/w/Book.xlsm", "ses_1");
    useChatUIStore.setState({ currentSessionId: "ses_1" });
    await doSendMessage("hi");   // no client connected → returns after the reset
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("reset_vba_run_budget", { xlsmPath: "c:/w/book.xlsm" });
  });
});
// MacroChatPane.test.tsx
it("new chat resets the run budget for this workbook", async () => { /* click new chat → invoke called with ("reset_vba_run_budget", { xlsmPath: filePath }) */ });
```
- [ ] **Step 2:** run → FAIL. **Step 3: Implement.** **Step 4:** `npx vitest run src/features/opencode-config src/features/preview/components/MacroChatPane.test.tsx` PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(macro-chat): reset the vba_run budget on every user message, question reply and new chat`

---

### Task 12: Whole-feature verification

- [ ] **Step 1:** `cd src-tauri && cargo test --lib` → all pass; `cargo build` warnings-free for the new files.
- [ ] **Step 2:** `npx vitest run` → all pass (includes `locale-parity`); `npx tsc --noEmit` clean.
- [ ] **Step 3:** `cargo test --lib -- --ignored vba_run_excel` on this PC → pass; afterwards `Get-Process excel -ErrorAction SilentlyContinue` is empty.
- [ ] **Step 4: Desktop smoke** (spec 12, with winuse or by hand): open an `.xlsm` in MDium, in the macro chat ask "A 列の合計を B1 に書くマクロ Sum を作って、動作確認までお願いします"; expect the AI to run baseline (`source: "workbook"`), edit, `vba_run`, then `vba_push`; confirm the original file's modification time did not change before the push, a `runs/<ts>_Sum/<name>.xlsm` exists, and B1 in the run copy holds the sum. Then ask for a macro that calls `Kill` → expect the MDium approval dialog; decline → AI reports `approval_denied`.
- [ ] **Step 5:** Record any deviations in the spec's section 13, commit `docs(vba): record run-and-verify implementation notes`.
