import { describe, expect, it } from "vitest";
import { isAtLeast, probeCodex, type CommandRunner } from "../availability";

function runner(map: Record<string, { status: number | null; stdout?: string; stderr?: string; error?: Error }>): CommandRunner {
  return (_cmd, args) => {
    const r = map[args.join(" ")] ?? { status: 1 };
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
  };
}

describe("isAtLeast", () => {
  it.each([
    ["0.152.1", "0.152.0", true],
    ["0.152.0", "0.152.0", true],
    ["0.151.9", "0.152.0", false],
    ["1.0.0-beta.1", "1.0.0", true],
    ["garbage", "1.0.0", false],
  ])("%s >= %s is %s", (v, min, expected) => {
    expect(isAtLeast(v, min)).toBe(expected);
  });
});

describe("probeCodex", () => {
  it("reports missing when no executable was resolved", () => {
    expect(probeCodex(null, runner({}))).toMatchObject({ kind: "missing" });
  });

  it("reports missing when the executable cannot run", () => {
    expect(probeCodex("codex.exe", runner({ "--version": { status: null, error: new Error("ENOENT") } })))
      .toMatchObject({ kind: "missing" });
  });

  it("reports too_old with the detected version", () => {
    expect(probeCodex("codex.exe", runner({ "--version": { status: 0, stdout: "codex-cli 0.100.0" } })))
      .toEqual({ kind: "too_old", detail: "0.152.0", detectedVersion: "0.100.0" });
  });

  it("reports unauthenticated when login status fails", () => {
    expect(probeCodex("codex.exe", runner({
      "--version": { status: 0, stdout: "codex-cli 0.152.1" },
      "login status": { status: 1 },
    }))).toEqual({ kind: "unauthenticated", detail: "codex login", detectedVersion: "0.152.1" });
  });

  it("reports available", () => {
    expect(probeCodex("codex.exe", runner({
      "--version": { status: 0, stdout: "codex-cli 0.152.1" },
      "login status": { status: 0, stdout: "Logged in" },
    }))).toEqual({ kind: "available", version: "0.152.1" });
  });
});
