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
pub const REC_MODULEPRIVATE: u16 = 0x0028;
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

    #[allow(dead_code)] // Part of the DirStream API; exercised by tests.
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

    /// Append a MODULE record group (MS-OVBA 2.3.4.2.3.2). `private` emits
    /// MODULEPRIVATE, which Excel writes for every class whose
    /// `VB_Exposed = False`; without it VBA fails to compile code that
    /// references the class (runtime error 5).
    pub fn append_module(
        &mut self,
        name: &str,
        stream_name: &str,
        kind: ModuleKind,
        text_offset: u32,
        private: bool,
        code_page: u16,
    ) -> Result<(), String> {
        let utf16 = |s: &str| -> Vec<u8> { s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect() };
        let type_id = match kind {
            ModuleKind::Standard => REC_MODULETYPE_PROCEDURAL,
            _ => REC_MODULETYPE_OTHER,
        };
        let mut new_records = vec![
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
        ];
        if private {
            new_records.push(DirRecord { id: REC_MODULEPRIVATE, data: vec![] });
        }
        new_records.push(DirRecord { id: REC_MODULETERMINATOR, data: vec![] });
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
        dir.append_module("Helpers", "Helpers", ModuleKind::Standard, 0, false, 1252).unwrap();
        let expected = dir_bytes_with_modules(1, &module_bytes("Helpers", 0x0021, 0));
        assert_eq!(dir.serialize(), expected);
        assert_eq!(dir.module_count(), Some(1));
    }

    #[test]
    fn dir_stream_append_class_uses_type_0x22() {
        let mut dir = DirStream::parse(&dir_bytes_with_modules(0, &[])).unwrap();
        dir.append_module("C", "C", ModuleKind::Class, 0, true, 1252).unwrap();
        assert_eq!(dir.modules()[0].type_id, 0x0022);
    }

    #[test]
    fn dir_stream_append_private_class_emits_moduleprivate_before_terminator() {
        let mut dir = DirStream::parse(&dir_bytes_with_modules(0, &[])).unwrap();
        dir.append_module("C", "C", ModuleKind::Class, 0, true, 1252).unwrap();
        let ids: Vec<u16> = dir.records.iter().map(|r| r.id).collect();
        let type_at = ids.iter().position(|&id| id == 0x0022).unwrap();
        assert_eq!(ids[type_at + 1], REC_MODULEPRIVATE);
        assert_eq!(ids[type_at + 2], REC_MODULETERMINATOR);
        // An exposed class (VB_Exposed = True) must not carry MODULEPRIVATE.
        let mut dir = DirStream::parse(&dir_bytes_with_modules(0, &[])).unwrap();
        dir.append_module("P", "P", ModuleKind::Class, 0, false, 1252).unwrap();
        assert!(dir.records.iter().all(|r| r.id != REC_MODULEPRIVATE));
        assert_eq!(dir.serialize(), dir_bytes_with_modules(1, &module_bytes("P", 0x0022, 0)));
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
}
