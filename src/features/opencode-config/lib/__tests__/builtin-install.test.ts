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
