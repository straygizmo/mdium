//! Generates the `MdiumShim` VBA module injected into a disposable workbook copy.
//!
//! The shim shadows `MsgBox` / `InputBox` (project-level procedures win over the
//! VBA library), wraps each macro in a `MdiumRunN` function that returns errors
//! as a string, and records every dialog call into a log.

use serde::{Deserialize, Serialize};

pub const SHIM_MODULE_NAME: &str = "MdiumShim";
/// Separator between fields of one log record (ASCII Unit Separator).
pub const FIELD_SEP: char = '\u{1f}';
/// Separator between log records (ASCII Record Separator).
pub const RECORD_SEP: char = '\u{1e}';

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MsgBoxResponse {
    Ok,
    Cancel,
    Abort,
    Retry,
    Ignore,
    Yes,
    No,
}

impl MsgBoxResponse {
    /// The VBA constant value (vbOK=1 ... vbNo=7).
    pub fn vb_value(self) -> u8 {
        match self {
            MsgBoxResponse::Ok => 1,
            MsgBoxResponse::Cancel => 2,
            MsgBoxResponse::Abort => 3,
            MsgBoxResponse::Retry => 4,
            MsgBoxResponse::Ignore => 5,
            MsgBoxResponse::Yes => 6,
            MsgBoxResponse::No => 7,
        }
    }
}

#[derive(Debug, Clone)]
pub struct MacroCall {
    pub module: String,
    pub proc: String,
    pub args: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Default)]
pub struct ShimSpec {
    pub macros: Vec<MacroCall>,
    pub inputs: Vec<String>,
    pub msgbox_responses: Vec<MsgBoxResponse>,
}

/// Renders a Rust string as a VBA string expression. Quotes are doubled and
/// line breaks become `vbCrLf` / `vbLf` / `vbCr` concatenations.
pub fn vba_string_literal(s: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        let nl = match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                    Some("vbCrLf")
                } else {
                    Some("vbCr")
                }
            }
            '\n' => Some("vbLf"),
            _ => None,
        };
        match nl {
            Some(name) => {
                parts.push(format!("\"{cur}\""));
                parts.push(name.to_string());
                cur.clear();
            }
            None if c == '"' => cur.push_str("\"\""),
            None => cur.push(c),
        }
    }
    parts.push(format!("\"{cur}\""));
    parts.join(" & ")
}

/// Renders a JSON scalar as a VBA argument literal.
pub fn vba_arg_literal(v: &serde_json::Value) -> Result<String, String> {
    match v {
        serde_json::Value::String(s) => Ok(vba_string_literal(s)),
        serde_json::Value::Number(n) => Ok(n.to_string()),
        serde_json::Value::Bool(b) => Ok(if *b { "True" } else { "False" }.to_string()),
        _ => Err("unsupported argument type".to_string()),
    }
}

const HEADER: &str = r#"Attribute VB_Name = "MdiumShim"
Option Explicit

Private mLog As String
Private mInputIdx As Long
Private mMsgIdx As Long

Private Function Inputs() As Variant
    Inputs = Array(@INPUTS@)
End Function

Private Function MsgResponses() As Variant
    MsgResponses = Array(@RESPONSES@)
End Function

' Appends one record: fields joined by Chr(31), terminated by Chr(30).
Private Sub Append(ParamArray f() As Variant)
    Dim i As Long
    Dim s As String
    For i = LBound(f) To UBound(f)
        If i > LBound(f) Then s = s & Chr(31)
        s = s & CStr(f(i))
    Next i
    mLog = mLog & s & Chr(30)
End Sub

' Mirrors the button Windows would pick as the default answer.
Private Function DefaultButton(ByVal Buttons As Long) As Long
    Select Case (Buttons And 15)
        Case 0, 1
            DefaultButton = 1
        Case 2
            DefaultButton = 3
        Case 3, 4
            DefaultButton = 6
        Case 5
            DefaultButton = 4
        Case Else
            DefaultButton = 1
    End Select
End Function

Public Function MsgBox(Prompt, Optional Buttons As VbMsgBoxStyle = vbOKOnly, Optional Title, Optional HelpFile, Optional Context) As VbMsgBoxResult
    Dim r As Long
    Dim resp As Variant
    resp = MsgResponses()
    If mMsgIdx <= UBound(resp) Then
        r = resp(mMsgIdx)
    Else
        r = DefaultButton(Buttons)
    End If
    mMsgIdx = mMsgIdx + 1
    Append "msgbox", CStr(Prompt), CStr(Title & ""), CStr(r)
    MsgBox = r
End Function

Public Function InputBox(Prompt, Optional Title, Optional Default, Optional XPos, Optional YPos, Optional HelpFile, Optional Context) As String
    Dim s As String
    Dim exhausted As Boolean
    Dim inp As Variant
    inp = Inputs()
    If mInputIdx <= UBound(inp) Then
        s = CStr(inp(mInputIdx))
    Else
        s = CStr(Default & "")
        exhausted = True
    End If
    mInputIdx = mInputIdx + 1
    Append "inputbox", CStr(Prompt), CStr(Title & ""), s, IIf(exhausted, "exhausted", "")
    InputBox = s
End Function

Public Function MdiumTakeLog() As String
    MdiumTakeLog = mLog
    mLog = ""
End Function
"#;

const WRAPPER: &str = r#"
Public Function MdiumRun@N@() As String
    On Error GoTo Fail
    Dim t0 As Single
    t0 = Timer
    Call @CALL@
    MdiumRun@N@ = "ok" & Chr(31) & CStr(Int((Timer - t0) * 1000)) & Chr(31) & MdiumTakeLog()
    Exit Function
Fail:
    MdiumRun@N@ = "error" & Chr(31) & CStr(Err.Number) & Chr(31) & Err.Source & Chr(31) & Err.Description & Chr(31) & MdiumTakeLog()
End Function
"#;

/// Renders the complete module text (CRLF line endings).
/// Macro arguments that cannot be rendered are emitted as `Empty` so the
/// text stays valid; callers should validate with `vba_arg_literal` first.
pub fn render_shim(spec: &ShimSpec) -> String {
    let inputs = spec
        .inputs
        .iter()
        .map(|s| vba_string_literal(s))
        .collect::<Vec<_>>()
        .join(", ");
    let responses = spec
        .msgbox_responses
        .iter()
        .map(|r| r.vb_value().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let mut out = HEADER
        .replace("@INPUTS@", &inputs)
        .replace("@RESPONSES@", &responses);
    for (i, m) in spec.macros.iter().enumerate() {
        let mut call = format!("{}.{}", m.module, m.proc);
        if !m.args.is_empty() {
            let args = m
                .args
                .iter()
                .map(|a| vba_arg_literal(a).unwrap_or_else(|_| "Empty".to_string()))
                .collect::<Vec<_>>()
                .join(", ");
            call = format!("{call}({args})");
        }
        out.push_str(
            &WRAPPER
                .replace("@N@", &(i + 1).to_string())
                .replace("@CALL@", &call),
        );
    }
    out.replace("\r\n", "\n").replace('\n', "\r\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn string_literal_doubles_quotes_and_splits_newlines() {
        assert_eq!(vba_string_literal("a\"b"), "\"a\"\"b\"");
        assert_eq!(vba_string_literal("x\r\ny"), "\"x\" & vbCrLf & \"y\"");
        assert_eq!(vba_string_literal("x\ny"), "\"x\" & vbLf & \"y\"");
        assert_eq!(vba_string_literal("x\ry"), "\"x\" & vbCr & \"y\"");
        assert_eq!(vba_string_literal(""), "\"\"");
    }

    #[test]
    fn arg_literals_cover_json_scalars() {
        assert_eq!(vba_arg_literal(&json!("Sheet1")).unwrap(), "\"Sheet1\"");
        assert_eq!(vba_arg_literal(&json!(10)).unwrap(), "10");
        assert_eq!(vba_arg_literal(&json!(2.5)).unwrap(), "2.5");
        assert_eq!(vba_arg_literal(&json!(true)).unwrap(), "True");
        assert_eq!(vba_arg_literal(&json!(false)).unwrap(), "False");
        assert!(vba_arg_literal(&json!([1])).is_err());
        assert!(vba_arg_literal(&json!(null)).is_err());
    }

    fn two_macro_spec() -> ShimSpec {
        ShimSpec {
            macros: vec![
                MacroCall { module: "Module1".into(), proc: "Main".into(), args: vec![] },
                MacroCall {
                    module: "Module1".into(),
                    proc: "Fill".into(),
                    args: vec![json!("Sheet1"), json!(10)],
                },
            ],
            inputs: vec!["42".into(), "東京".into()],
            msgbox_responses: vec![MsgBoxResponse::Yes],
        }
    }

    #[test]
    fn render_shim_declares_shadows_and_one_wrapper_per_macro() {
        let s = render_shim(&two_macro_spec());
        assert!(s.starts_with("Attribute VB_Name = \"MdiumShim\"\r\n"));
        for needle in [
            "Option Explicit",
            "Public Function MsgBox(Prompt, Optional Buttons As VbMsgBoxStyle = vbOKOnly",
            "Public Function InputBox(Prompt, Optional Title, Optional Default",
            "Public Function MdiumTakeLog() As String",
            "Public Function MdiumRun1() As String",
            "Public Function MdiumRun2() As String",
            "Call Module1.Main\r\n",
            "Call Module1.Fill(\"Sheet1\", 10)",
            "Array(\"42\", \"東京\")",
            "Array(6)",
            "On Error GoTo Fail",
            "Chr(31)",
            "Chr(30)",
        ] {
            assert!(s.contains(needle), "{needle}");
        }
        assert!(!s.contains("MdiumRun3"));
        assert!(s.matches("\r\n").count() == s.matches('\n').count(), "CRLF only");
    }

    #[test]
    fn render_shim_with_no_macros_still_has_take_log() {
        let s = render_shim(&ShimSpec::default());
        assert!(!s.contains("MdiumRun1"));
        assert!(s.contains("Public Function MdiumTakeLog() As String"));
        assert!(s.contains("Inputs = Array()"));
        assert!(s.contains("MsgResponses = Array()"));
    }

    #[test]
    fn default_button_table_is_rendered() {
        let s = render_shim(&ShimSpec::default());
        for needle in [
            "Case 0, 1\r\n            DefaultButton = 1",
            "Case 2\r\n            DefaultButton = 3",
            "Case 3, 4\r\n            DefaultButton = 6",
            "Case 5\r\n            DefaultButton = 4",
            "Case Else\r\n            DefaultButton = 1",
        ] {
            assert!(s.contains(needle), "{needle}");
        }
    }

    #[test]
    fn msgbox_response_deserializes_lowercase() {
        let v: Vec<MsgBoxResponse> = serde_json::from_str("[\"yes\",\"cancel\"]").unwrap();
        assert_eq!(v, vec![MsgBoxResponse::Yes, MsgBoxResponse::Cancel]);
        assert_eq!(MsgBoxResponse::No.vb_value(), 7);
    }
}
