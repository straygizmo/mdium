import { describe, expect, it } from "vitest";
import { TERMINAL_KINDS, getTerminalCommand, getTerminalThemeType } from "../terminal-session";

describe("terminal session definitions", () => {
  it("lists every supported kind in dropdown order", () => {
    expect(TERMINAL_KINDS).toEqual(["claude-code", "codex", "github-copilot", "opencode", "terminal"]);
  });

  it("maps CLI kinds to their launch command", () => {
    expect(getTerminalCommand("claude-code")).toBe("claude");
    expect(getTerminalCommand("codex")).toBe("codex");
    expect(getTerminalCommand("github-copilot")).toBe("copilot");
    expect(getTerminalCommand("opencode")).toBe("opencode");
    expect(getTerminalCommand("terminal")).toBeUndefined();
  });

  it("uses a dark palette for Codex regardless of the app theme", () => {
    expect(getTerminalThemeType("codex", "light")).toBe("dark");
    expect(getTerminalThemeType("codex", "dark")).toBe("dark");
    expect(getTerminalThemeType("terminal", "light")).toBe("light");
    expect(getTerminalThemeType("opencode", "dark")).toBe("dark");
  });
});
