//! Legacy Word (.doc) → .docx conversion through Microsoft Word automation.
//!
//! Word is driven over COM from a hidden PowerShell process, so this only
//! works on Windows with Word installed. The produced `.docx` is written next
//! to the source `.doc` and its path is returned to the frontend, which then
//! runs the regular docx → Markdown pipeline on it.

use std::path::{Path, PathBuf};

/// Prefix of the error string when Word itself cannot be started. The
/// frontend keys off this to show a localized "Word not installed" message.
pub const WORD_NOT_AVAILABLE: &str = "WORD_NOT_AVAILABLE";

/// Sibling `.docx` path for a `.doc` (same directory, same stem).
pub fn docx_sibling_path(doc_path: &Path) -> PathBuf {
    doc_path.with_extension("docx")
}

#[tauri::command]
pub async fn convert_doc_to_docx(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || convert_doc_to_docx_blocking(Path::new(&path)))
        .await
        .map_err(|e| format!("doc conversion task failed: {e}"))?
}

fn convert_doc_to_docx_blocking(doc_path: &Path) -> Result<String, String> {
    if !doc_path.is_file() {
        return Err(format!("File not found: {}", doc_path.display()));
    }
    let docx_path = docx_sibling_path(doc_path);
    // A .docx that already sits next to the .doc is reused as-is rather than
    // overwritten: it may be the user's own file, not one we generated.
    if docx_path.is_file() {
        return Ok(docx_path.to_string_lossy().into_owned());
    }
    run_word_conversion(doc_path, &docx_path)?;
    if !docx_path.is_file() {
        return Err(format!(
            "Word reported success but {} was not created",
            docx_path.display()
        ));
    }
    Ok(docx_path.to_string_lossy().into_owned())
}

#[cfg(target_os = "windows")]
fn run_word_conversion(doc_path: &Path, docx_path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    // Paths travel through environment variables so no quoting of user
    // supplied file names is needed inside the script.
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", WORD_CONVERT_SCRIPT])
        .env("MDIUM_DOC_IN", doc_path)
        .env("MDIUM_DOC_OUT", docx_path)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| format!("Failed to start PowerShell: {e}"))?;

    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("unknown error")
        .to_string();
    if output.status.code() == Some(2) || detail.contains(WORD_NOT_AVAILABLE) {
        return Err(format!("{WORD_NOT_AVAILABLE}: {detail}"));
    }
    Err(format!("Word conversion failed: {detail}"))
}

#[cfg(not(target_os = "windows"))]
fn run_word_conversion(_doc_path: &Path, _docx_path: &Path) -> Result<(), String> {
    Err(format!(
        "{WORD_NOT_AVAILABLE}: converting .doc files requires Windows with Microsoft Word"
    ))
}

/// PowerShell driving Word over COM. Exit code 2 means Word could not be
/// created at all (not installed / COM blocked); 1 means the document failed.
///
/// The script is passed on the command line, where double quotes do not
/// survive PowerShell's own argument parsing, so it must only use single
/// quotes.
///
/// Open() arguments: ConfirmConversions=false, ReadOnly=true,
/// AddToRecentFiles=false, PasswordDocument=<dummy>. The dummy password is
/// ignored for unprotected files and makes protected ones fail immediately
/// instead of blocking on a password prompt.
#[cfg(target_os = "windows")]
const WORD_CONVERT_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
try {
  $word = New-Object -ComObject Word.Application
} catch {
  [Console]::Error.WriteLine('WORD_NOT_AVAILABLE: ' + $_.Exception.Message)
  exit 2
}
$code = 0
try {
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $word.AutomationSecurity = 3
  $doc = $word.Documents.Open($env:MDIUM_DOC_IN, $false, $true, $false, '__mdium_no_prompt__')
  try {
    $doc.SaveAs2([string]$env:MDIUM_DOC_OUT, 16)
  } finally {
    $doc.Close(0)
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  $code = 1
} finally {
  $word.Quit()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
exit $code
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docx_sibling_keeps_directory_and_stem() {
        let p = docx_sibling_path(Path::new(r"C:\docs\report.v2.doc"));
        assert_eq!(p, PathBuf::from(r"C:\docs\report.v2.docx"));
    }

    #[test]
    fn docx_sibling_handles_uppercase_extension() {
        let p = docx_sibling_path(Path::new(r"C:\docs\OLD.DOC"));
        assert_eq!(p, PathBuf::from(r"C:\docs\OLD.docx"));
    }

    /// Drives real Word. Run with
    /// `MDIUM_TEST_DOC=<path to a .doc> cargo test --lib doc_convert -- --ignored`.
    #[test]
    #[ignore]
    fn converts_a_real_doc_through_word() {
        let doc = std::env::var("MDIUM_TEST_DOC").expect("MDIUM_TEST_DOC must point at a .doc");
        let doc = Path::new(&doc);
        let docx = docx_sibling_path(doc);
        let _ = std::fs::remove_file(&docx);
        let out = convert_doc_to_docx_blocking(doc).expect("conversion succeeds");
        assert_eq!(Path::new(&out), docx);
        assert!(docx.is_file(), "docx was written");
    }

    #[test]
    fn reports_missing_doc_before_touching_word() {
        let err = convert_doc_to_docx_blocking(Path::new(r"C:\definitely\missing.doc")).unwrap_err();
        assert!(err.starts_with("File not found"), "{err}");
    }
}
