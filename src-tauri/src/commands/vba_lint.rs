//! Static checks over VBA module sources: push lint, side-effect scan and
//! procedure lookup for the run-and-verify loop.

use crate::commands::vba::{ModuleSource, PushWarning};
use crate::commands::vba_streams::ModuleKind;
use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::OnceLock;

fn resume_next_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^\s*On\s+Error\s+Resume\s+Next\b").unwrap())
}

fn procedure_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?im)^\s*(?:(Public|Private|Friend)\s+)?(?:Static\s+)?(?:Sub|Function|Property\s+(?:Get|Let|Set))\s+([A-Za-z_][A-Za-z0-9_]*)").unwrap()
    })
}

fn rem_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^Rem(?:\s|$)").unwrap())
}

fn side_effect_res() -> &'static Vec<Regex> {
    static RES: OnceLock<Vec<Regex>> = OnceLock::new();
    RES.get_or_init(|| {
        [
            r"\bKill\b",
            r"\bRmDir\b",
            r"\bMkDir\b",
            r"\bFileCopy\b",
            r"^\s*Name\s+\S.*\s+As\s+",
            r"\bOpen\s+.+\s+For\s+(Output|Append|Binary|Random)\b",
            r"FileSystemObject",
            // Both `Shell(...)` and the statement form `Shell "cmd", vbHide`.
            // Conservative: any identifier spelled exactly `Shell` (any case)
            // also hits, e.g. `Dim shell As Object`; `shellCount` does not.
            r"\bShell\b",
            r"\bCreateObject\s*\(",
            r"\bGetObject\s*\(",
            r"WScript\.Shell",
            r"MSXML2",
            r"WinHttp",
            r"Outlook\.Application",
            r"\.SendMail\b",
            r"URLDownloadToFile",
            // Open, OpenText, OpenXML, OpenDatabase.
            r"Workbooks\.Open\w*\b",
            r"\bSetAttr\b",
            r"\bSendKeys\b",
            r"\bExecuteExcel4Macro\b",
            r"\.SaveAs\b",
            r"\.SaveCopyAs\b",
            r"^\s*(?:Public\s+|Private\s+)?Declare\s+",
        ]
        .iter()
        .map(|p| Regex::new(&format!("(?i){}", p)).unwrap())
        .collect()
    })
}

/// True for lines that are entirely a VBA comment (`'` or `Rem`).
fn is_comment_line(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with('\'') || rem_re().is_match(t)
}

/// Number of `On Error Resume Next` statements outside comment lines.
pub fn count_on_error_resume_next(source: &str) -> usize {
    source.lines().filter(|l| !is_comment_line(l) && resume_next_re().is_match(l)).count()
}

/// Names of non-Private procedures (first spelling, case-insensitively deduplicated).
pub fn public_procedure_names(source: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in procedure_re().captures_iter(source) {
        if c.get(1).is_some_and(|s| s.as_str().eq_ignore_ascii_case("Private")) {
            continue;
        }
        let name = &c[2];
        if !out.iter().any(|n| n.eq_ignore_ascii_case(name)) {
            out.push(name.to_string());
        }
    }
    out
}

/// Warnings about a planned push. `touched` lists the updated and added module names.
pub fn lint_changes(before: &[ModuleSource], after: &[ModuleSource], touched: &[String]) -> Vec<PushWarning> {
    let is_touched = |name: &str| touched.iter().any(|t| t.eq_ignore_ascii_case(name));
    let mut warnings = Vec::new();
    for m in after.iter().filter(|m| is_touched(&m.name)) {
        let before_count = before
            .iter()
            .find(|b| b.name.eq_ignore_ascii_case(&m.name))
            .map_or(0, |b| count_on_error_resume_next(&b.source));
        let after_count = count_on_error_resume_next(&m.source);
        if after_count > before_count {
            warnings.push(PushWarning::OnErrorResumeNextAdded { module: m.name.clone(), before: before_count, after: after_count });
        }
    }
    // lowercase name -> (first spelling, modules)
    let mut groups: BTreeMap<String, (String, Vec<String>)> = BTreeMap::new();
    for m in after.iter().filter(|m| m.kind == ModuleKind::Standard) {
        for name in public_procedure_names(&m.source) {
            groups.entry(name.to_lowercase()).or_insert_with(|| (name.clone(), Vec::new())).1.push(m.name.clone());
        }
    }
    for (_, (name, mut modules)) in groups {
        if modules.len() >= 2 && modules.iter().any(|n| is_touched(n)) {
            modules.sort();
            warnings.push(PushWarning::DuplicateProcedure { name, modules });
        }
    }
    warnings
}

/// A source line that may touch the file system, network, processes or other applications.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SideEffectHit {
    pub module: String,
    pub line: usize,
    pub text: String,
}

/// Lines matching a side-effect pattern, sorted by (module, line). Comment lines are skipped.
pub fn scan_side_effects(modules: &[ModuleSource]) -> Vec<SideEffectHit> {
    let res = side_effect_res();
    let mut hits = Vec::new();
    for m in modules {
        for (i, line) in m.source.lines().enumerate() {
            if is_comment_line(line) {
                continue;
            }
            if res.iter().any(|re| re.is_match(line)) {
                hits.push(SideEffectHit { module: m.name.clone(), line: i + 1, text: line.trim().to_string() });
            }
        }
    }
    hits.sort_by(|a, b| a.module.cmp(&b.module).then(a.line.cmp(&b.line)));
    hits
}

/// SHA-256 hex over `module:line:text\n` for each hit, in order.
pub fn side_effects_fingerprint(hits: &[SideEffectHit]) -> String {
    let mut hasher = Sha256::new();
    for h in hits {
        hasher.update(format!("{}:{}:{}\n", h.module, h.line, h.text).as_bytes());
    }
    hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

/// Resolve `Module.Proc` or `Proc` to (module, procedure) with their declared spelling.
pub fn resolve_macro(modules: &[ModuleSource], spec: &str) -> Result<(String, String), String> {
    let spec = spec.trim();
    let find_in = |m: &ModuleSource, proc_name: &str| public_procedure_names(&m.source).into_iter().find(|n| n.eq_ignore_ascii_case(proc_name));
    if let Some((module, proc_name)) = spec.split_once('.') {
        if let Some(m) = modules.iter().find(|m| m.name.eq_ignore_ascii_case(module)) {
            return find_in(m, proc_name)
                .map(|n| (m.name.clone(), n))
                .ok_or_else(|| format!("Module '{}' has no public procedure '{}'", m.name, proc_name));
        }
        return Err(format!("Module '{}' not found", module));
    }
    let candidates: Vec<(String, String)> = modules.iter().filter_map(|m| find_in(m, spec).map(|n| (m.name.clone(), n))).collect();
    match candidates.len() {
        0 => Err(format!("No public procedure '{}' found", spec)),
        1 => Ok(candidates.into_iter().next().unwrap()),
        _ => {
            let list: Vec<String> = candidates.iter().map(|(m, p)| format!("{}.{}", m, p)).collect();
            Err(format!("'{}' is ambiguous; use one of: {}", spec, list.join(", ")))
        }
    }
}

/// True when any module declares a Sub/Function/Property (public or private) named `name`.
pub fn has_procedure(modules: &[ModuleSource], name: &str) -> bool {
    modules.iter().any(|m| procedure_re().captures_iter(&m.source).any(|c| c[2].eq_ignore_ascii_case(name)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(name: &str, src: &str) -> ModuleSource {
        ModuleSource { name: name.into(), kind: ModuleKind::Standard, source: src.into() }
    }

    #[test]
    fn counts_on_error_resume_next_ignoring_comments() {
        assert_eq!(count_on_error_resume_next("On Error Resume Next\r\n' On Error Resume Next\r\n  on error resume next\r\nRem On Error Resume Next\r\n"), 2);
    }

    #[test]
    fn lists_public_procedures_only() {
        let names = public_procedure_names("Private Sub A()\r\nEnd Sub\r\nPublic Function B() As Long\r\nEnd Function\r\nSub C()\r\nEnd Sub\r\nProperty Get D() As Long\r\nEnd Property\r\nFriend Sub E()\r\nEnd Sub\r\n");
        assert_eq!(names, vec!["B", "C", "D", "E"]);
    }

    #[test]
    fn warns_when_resume_next_count_grows_in_touched_module() {
        let before = vec![m("Module1", "Sub A()\r\nEnd Sub\r\n")];
        let after = vec![m("Module1", "Sub A()\r\nOn Error Resume Next\r\nEnd Sub\r\n")];
        assert_eq!(
            lint_changes(&before, &after, &["Module1".into()]),
            vec![PushWarning::OnErrorResumeNextAdded { module: "Module1".into(), before: 0, after: 1 }]
        );
    }

    #[test]
    fn no_warning_when_untouched_module_already_had_resume_next() {
        let after = vec![m("Module1", "Sub A()\r\nOn Error Resume Next\r\nEnd Sub\r\n")];
        assert!(lint_changes(&after, &after, &[]).is_empty());
    }

    #[test]
    fn warns_on_duplicate_public_procedure_across_standard_modules_when_one_is_touched() {
        let after = vec![m("Module1", "Sub TrimAll()\r\nEnd Sub\r\n"), m("Utils", "Public Sub trimall()\r\nEnd Sub\r\n")];
        let w = lint_changes(&after, &after, &["Utils".into()]);
        assert_eq!(w, vec![PushWarning::DuplicateProcedure { name: "TrimAll".into(), modules: vec!["Module1".into(), "Utils".into()] }]);
        assert!(lint_changes(&after, &after, &[]).is_empty());
    }

    #[test]
    fn class_modules_are_not_checked_for_duplicates() {
        let c = |n: &str| ModuleSource { name: n.into(), kind: ModuleKind::Class, source: "Private Sub Class_Initialize()\r\nEnd Sub\r\nPublic Sub Go()\r\nEnd Sub\r\n".into() };
        let after = vec![c("A"), c("B")];
        assert!(lint_changes(&after, &after, &["A".into(), "B".into()]).is_empty());
    }

    #[test]
    fn scans_side_effects_and_skips_comments_and_input_opens() {
        let hits = scan_side_effects(&[m("Module1", "Sub A()\r\n' Kill x\r\nKill \"a.txt\"\r\nOpen f For Input As #1\r\nOpen g For Output As #2\r\nSet fso = CreateObject(\"Scripting.FileSystemObject\")\r\nEnd Sub\r\n")]);
        assert_eq!(hits.iter().map(|h| h.line).collect::<Vec<_>>(), vec![3, 5, 6]);
        assert_eq!(hits[0].text, "Kill \"a.txt\"");
        assert_eq!(hits[0].module, "Module1");
    }

    #[test]
    fn scans_statement_shell_and_other_outside_effects() {
        let src = "Sub A()\r\nShell \"cmd /c del x\", vbHide\r\nx = Shell(\"notepad\")\r\nWorkbooks.OpenText \"a.csv\"\r\nWorkbooks.OpenXML \"a.xml\"\r\nSetAttr \"a.txt\", vbReadOnly\r\nSendKeys \"{ENTER}\"\r\nExecuteExcel4Macro \"x\"\r\nshellCount = 1\r\nEnd Sub\r\n";
        let hits = scan_side_effects(&[m("Module1", src)]);
        assert_eq!(hits.iter().map(|h| h.line).collect::<Vec<_>>(), vec![2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn fingerprint_is_stable_and_changes_with_hits() {
        let a = scan_side_effects(&[m("M", "Kill \"a\"\r\n")]);
        let b = scan_side_effects(&[m("M", "Kill \"a\"\r\n")]);
        let c = scan_side_effects(&[m("M", "Kill \"a\"\r\nMkDir \"d\"\r\n")]);
        assert_eq!(side_effects_fingerprint(&a), side_effects_fingerprint(&b));
        assert_ne!(side_effects_fingerprint(&a), side_effects_fingerprint(&c));
        assert_eq!(side_effects_fingerprint(&a).len(), 64);
    }

    #[test]
    fn resolve_macro_accepts_qualified_and_unqualified_names() {
        let mods = vec![m("Module1", "Sub Main()\r\nEnd Sub\r\n"), m("Utils", "Sub Helper()\r\nEnd Sub\r\n")];
        assert_eq!(resolve_macro(&mods, "Module1.Main").unwrap(), ("Module1".into(), "Main".into()));
        assert_eq!(resolve_macro(&mods, "helper").unwrap(), ("Utils".into(), "Helper".into()));
        assert!(resolve_macro(&mods, "Nope").is_err());
        assert!(resolve_macro(&mods, "Utils.Main").is_err());
    }

    #[test]
    fn resolve_macro_rejects_ambiguous_unqualified_name() {
        let mods = vec![m("Module1", "Sub Helper()\r\nEnd Sub\r\n"), m("Utils", "Sub Helper()\r\nEnd Sub\r\n")];
        let e = resolve_macro(&mods, "Helper").unwrap_err();
        assert!(e.contains("Module1.Helper") && e.contains("Utils.Helper"));
    }

    #[test]
    fn has_procedure_sees_private_ones() {
        assert!(has_procedure(&[m("A", "Private Function MsgBox()\r\nEnd Function\r\n")], "msgbox"));
    }
}
