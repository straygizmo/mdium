use crate::commands::vba::{decode_bytes, encode_string};

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
