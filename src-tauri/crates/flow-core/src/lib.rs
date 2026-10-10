//! Generic flow engine of MDium (spec 2026-10-06 and 2026-10-10 chapter 10).
//! This crate has no Tauri dependency; the desktop app and the flow server
//! both build on it.

#[cfg(test)]
mod tests {
    #[test]
    fn crate_builds() {
        assert_eq!(2 + 2, 4);
    }
}
