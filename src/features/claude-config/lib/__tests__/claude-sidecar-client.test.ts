import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { parseSidecarLine } from "../claude-sidecar-client";

describe("parseSidecarLine", () => {
  it("parses a valid outbound message", () => {
    expect(parseSidecarLine('{"type":"ready"}')).toEqual({ type: "ready" });
  });

  it("returns null for invalid JSON", () => {
    expect(parseSidecarLine("not json")).toBeNull();
  });

  it("returns null for JSON without a string type", () => {
    expect(parseSidecarLine('{"foo":1}')).toBeNull();
    expect(parseSidecarLine('"just a string"')).toBeNull();
  });
});
