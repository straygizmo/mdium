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

  it("vba-mdium-flow v4 teaches the run-and-verify loop", () => {
    const skill = BUILTIN_SKILLS["vba-mdium-flow"];
    expect(skill.version).toBe(4);
    const body = skill.content;
    for (const needle of ["vba_run", "xlsx_read", "source: \"workbook\"", "run_budget_exhausted", "side_effects_detected", "allow_side_effects", "approval_denied", "approval_timeout", "on_error_resume_next_added", "duplicate_procedure", "ThunderDFrame", "runCopyPath", "3 fix-and-rerun", "whatever the number of macros", "instead of step 4"]) {
      expect(body).toContain(needle);
    }
    expect(body).not.toContain("MDium does not run macros");
  });
});
