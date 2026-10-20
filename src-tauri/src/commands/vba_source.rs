use crate::commands::vba_streams::ModuleKind;

/// Parse the `Attribute VB_Name = "..."` line from VBA source code.
/// Returns the module name if found, None otherwise.
pub fn extract_vb_name(source: &str) -> Option<String> {
    for line in source.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Attribute VB_Name") {
            let rest = rest.trim();
            if let Some(rest) = rest.strip_prefix('=') {
                let rest = rest.trim();
                if let Some(rest) = rest.strip_prefix('"') {
                    if let Some(end) = rest.find('"') {
                        return Some(rest[..end].to_string());
                    }
                }
            }
        }
    }
    None
}

/// Ensure the `Attribute VB_Name = "..."` line in VBA source matches the
/// expected module name.  When VBE renames a module the dir-stream
/// MODULENAME is updated but the compressed source may still carry the old
/// `Attribute VB_Name`.  This helper rewrites the line so that the source
/// is always consistent with the dir stream, which prevents VBA/Excel from
/// rejecting the compressed source in favour of the (stale) performance
/// cache.
pub fn fix_vb_name(source: &str, expected_name: &str) -> String {
    let mut result = String::with_capacity(source.len());
    let mut found = false;
    for line in source.lines() {
        if !found {
            let trimmed = line.trim();
            if trimmed.starts_with("Attribute VB_Name") {
                if let Some(rest) = trimmed.strip_prefix("Attribute VB_Name") {
                    let rest = rest.trim();
                    if let Some(rest) = rest.strip_prefix('=') {
                        let rest = rest.trim();
                        if rest.starts_with('"') {
                            result.push_str(&format!("Attribute VB_Name = \"{}\"", expected_name));
                            result.push_str("\r\n");
                            found = true;
                            continue;
                        }
                    }
                }
            }
        }
        result.push_str(line);
        result.push_str("\r\n");
    }
    // Remove the trailing \r\n if the original source didn't end with one
    if !source.ends_with('\n') && result.ends_with("\r\n") {
        result.truncate(result.len() - 2);
    }
    result
}


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

/// Header attributes VBA stores for every class module, in the order Excel
/// writes them (keys are matched case-insensitively). `VB_Base` names the
/// built-in class base type; Excel cannot compile a class module without it
/// (the VBE reports runtime error 5 "Invalid procedure call"). A .cls exported
/// by the VBE only carries the middle four, so push fills in the rest.
const CLASS_ATTRIBUTES: [(&str, &str); 7] = [
    ("VB_Base", "\"0{FCFB3D2A-A0FA-1068-A738-08002B3371B5}\""),
    ("VB_GlobalNameSpace", "False"),
    ("VB_Creatable", "False"),
    ("VB_PredeclaredId", "False"),
    ("VB_Exposed", "False"),
    ("VB_TemplateDerived", "False"),
    ("VB_Customizable", "False"),
];

/// `Some(key)` when `line` is `Attribute <key> = ...` for one of CLASS_ATTRIBUTES.
fn class_attribute_key(line: &str) -> Option<&'static str> {
    let t = line.trim();
    let rest = t.get(..9).filter(|h| h.eq_ignore_ascii_case("Attribute")).map(|_| t[9..].trim_start())?;
    let key = rest.split('=').next()?.trim();
    CLASS_ATTRIBUTES.iter().map(|(k, _)| *k).find(|k| k.eq_ignore_ascii_case(key))
}

/// True when the source carries `Attribute VB_Exposed = True`. Classes without
/// it are private to the project and are stored with MODULEPRIVATE in `dir`.
pub fn is_exposed(source: &str) -> bool {
    source.lines().any(|l| {
        let t = l.trim().to_ascii_lowercase();
        t.starts_with("attribute vb_exposed") && t.split('=').nth(1).map(|v| v.trim() == "true").unwrap_or(false)
    })
}

/// Shape a module file the way VBA stores it inside vbaProject.bin:
/// no BOM, CRLF, no exported-.cls VERSION header, `Attribute VB_Name` equal
/// to the file name, and for classes the full attribute header right after
/// `VB_Name` in Excel's order (values the file already sets are kept).
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
        // Pull the class attributes out wherever they are, then re-emit the
        // whole header after VB_Name with the file's values or the defaults.
        let mut values: Vec<Option<String>> = vec![None; CLASS_ATTRIBUTES.len()];
        let mut body: Vec<&str> = Vec::new();
        for line in out.split("\r\n") {
            match class_attribute_key(line) {
                Some(key) => {
                    let idx = CLASS_ATTRIBUTES.iter().position(|(k, _)| *k == key).unwrap();
                    if values[idx].is_none() {
                        values[idx] = line.split_once('=').map(|(_, v)| v.trim().to_string());
                    }
                }
                None => body.push(line),
            }
        }
        let mut rebuilt = String::new();
        let mut lines = body.into_iter();
        if let Some(first) = lines.next() {
            rebuilt.push_str(first);
            rebuilt.push_str("\r\n");
        }
        for (i, (key, default)) in CLASS_ATTRIBUTES.iter().enumerate() {
            let value = values[i].as_deref().filter(|v| !v.is_empty()).unwrap_or(default);
            rebuilt.push_str(&format!("Attribute {} = {}\r\n", key, value));
        }
        let rest: Vec<&str> = lines.collect();
        rebuilt.push_str(&rest.join("\r\n"));
        out = rebuilt;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_exposed_reads_the_vb_exposed_attribute() {
        assert!(!is_exposed("Attribute VB_Name = \"C\"\r\nAttribute VB_Exposed = False\r\n"));
        assert!(is_exposed("Attribute VB_Name = \"C\"\r\nattribute vb_exposed = TRUE\r\n"));
        assert!(!is_exposed("Attribute VB_Name = \"C\"\r\n"));
    }

    #[test]
    fn test_fix_vb_name_replaces_old_name() {
        let source = "Attribute VB_Name = \"Module1\"\r\nSub Test()\r\nEnd Sub\r\n";
        let result = fix_vb_name(source, "mdlMain");
        assert!(result.starts_with("Attribute VB_Name = \"mdlMain\"\r\n"));
        assert!(result.contains("Sub Test()"));
    }

    #[test]
    fn test_fix_vb_name_keeps_matching_name() {
        let source = "Attribute VB_Name = \"mdlMain\"\r\nSub Test()\r\nEnd Sub\r\n";
        let result = fix_vb_name(source, "mdlMain");
        assert!(result.starts_with("Attribute VB_Name = \"mdlMain\"\r\n"));
        assert!(result.contains("Sub Test()"));
    }

    #[test]
    fn test_fix_vb_name_no_attribute_line() {
        let source = "Sub Test()\r\nEnd Sub\r\n";
        let result = fix_vb_name(source, "mdlMain");
        // No Attribute line to fix — source returned as-is
        assert!(result.contains("Sub Test()"));
    }

    #[test]
    fn test_fix_vb_name_preserves_other_attributes() {
        let source = "Attribute VB_Name = \"Module1\"\r\nAttribute VB_Exposed = False\r\nSub Test()\r\nEnd Sub\r\n";
        let result = fix_vb_name(source, "mdlMain");
        assert!(result.contains("Attribute VB_Name = \"mdlMain\""));
        assert!(result.contains("Attribute VB_Exposed = False"));
        assert!(result.contains("Sub Test()"));
    }

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
        let expected = "Attribute VB_Name = \"C\"\r\nAttribute VB_Base = \"0{FCFB3D2A-A0FA-1068-A738-08002B3371B5}\"\r\nAttribute VB_GlobalNameSpace = False\r\nAttribute VB_Creatable = False\r\nAttribute VB_PredeclaredId = False\r\nAttribute VB_Exposed = False\r\nAttribute VB_TemplateDerived = False\r\nAttribute VB_Customizable = False\r\nPublic Sub Hi()\r\nEnd Sub\r\n";
        assert_eq!(out, expected);
    }

    #[test]
    fn normalize_keeps_a_native_class_header_unchanged() {
        // Exactly what Excel stores for a class module (pull output).
        let src = "Attribute VB_Name = \"Greeter\"\r\nAttribute VB_Base = \"0{FCFB3D2A-A0FA-1068-A738-08002B3371B5}\"\r\nAttribute VB_GlobalNameSpace = False\r\nAttribute VB_Creatable = False\r\nAttribute VB_PredeclaredId = False\r\nAttribute VB_Exposed = False\r\nAttribute VB_TemplateDerived = False\r\nAttribute VB_Customizable = False\r\nOption Explicit\r\n\r\nPublic Function Greet() As String\r\nEnd Function\r\n";
        assert_eq!(normalize_source(src, "Greeter", ModuleKind::Class), src);
    }

    #[test]
    fn normalize_reorders_class_attributes_and_keeps_other_attribute_lines() {
        let src = "Attribute VB_Name = \"C\"\r\nAttribute VB_Exposed = True\r\nAttribute VB_Description = \"doc\"\r\nattribute vb_base = \"0{FCFB3D2A-A0FA-1068-A738-08002B3371B5}\"\r\nSub X()\r\nEnd Sub\r\n";
        let out = normalize_source(src, "C", ModuleKind::Class);
        let expected = "Attribute VB_Name = \"C\"\r\nAttribute VB_Base = \"0{FCFB3D2A-A0FA-1068-A738-08002B3371B5}\"\r\nAttribute VB_GlobalNameSpace = False\r\nAttribute VB_Creatable = False\r\nAttribute VB_PredeclaredId = False\r\nAttribute VB_Exposed = True\r\nAttribute VB_TemplateDerived = False\r\nAttribute VB_Customizable = False\r\nAttribute VB_Description = \"doc\"\r\nSub X()\r\nEnd Sub\r\n";
        assert_eq!(out, expected);
    }

    #[test]
    fn normalize_keeps_existing_class_attributes() {
        let src = "Attribute VB_Name = \"C\"\r\nAttribute VB_GlobalNameSpace = False\r\nAttribute VB_Creatable = False\r\nAttribute VB_PredeclaredId = True\r\nAttribute VB_Exposed = False\r\nSub X()\r\nEnd Sub\r\n";
        let out = normalize_source(src, "C", ModuleKind::Class);
        assert!(out.contains("Attribute VB_PredeclaredId = True\r\n"));
        assert!(out.contains("Attribute VB_Base = "));
        assert_eq!(out.matches("VB_PredeclaredId").count(), 1);
        assert!(out.ends_with("Sub X()\r\nEnd Sub\r\n"));
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
}
