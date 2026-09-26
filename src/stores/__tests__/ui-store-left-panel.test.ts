import { describe, expect, it } from "vitest";
import { normalizeLeftPanel } from "../ui-store";

describe("normalizeLeftPanel", () => {
  it("keeps known panels", () => {
    expect(normalizeLeftPanel("git")).toBe("git");
    expect(normalizeLeftPanel("opencode-config")).toBe("opencode-config");
    expect(normalizeLeftPanel("workflow")).toBe("workflow");
  });

  it("maps the retired Claude panel to AGENT CHAT", () => {
    expect(normalizeLeftPanel("claude")).toBe("opencode-config");
  });

  it("falls back to the folder panel for unknown values", () => {
    expect(normalizeLeftPanel("nope")).toBe("folder");
    expect(normalizeLeftPanel(undefined)).toBe("folder");
  });
});
