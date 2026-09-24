import { describe, expect, it } from "vitest";
import { isAtLeast, probeCodex, runCommand, type CommandRunner } from "../availability";

function runner(map: Record<string, { status: number | null; stdout?: string; stderr?: string; error?: NodeJS.ErrnoException }>): CommandRunner {
  return async (_cmd, args) => {
    const r = map[args.join(" ")] ?? { status: 1 };
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
  };
}

describe("runCommand", () => {
  it("resolves with status for non-zero exit", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.exit(3)"]);
    expect(result).toEqual({ status: 3, stdout: "", stderr: "", error: undefined });
  });

  it("resolves with error for missing binary", async () => {
    const result = await runCommand("definitely-not-a-real-binary-xyz", []);
    expect(result.status).toBe(null);
    expect(result.error?.code).toBe("ENOENT");
  });
});

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
  it("reports missing when no executable was resolved", async () => {
    expect(await probeCodex(null, runner({}))).toMatchObject({ kind: "missing" });
  });

  it("reports missing when the executable cannot run (ENOENT)", async () => {
    const enoentError = Object.assign(new Error("not found"), { code: "ENOENT" });
    expect(await probeCodex("codex.exe", runner({ "--version": { status: null, error: enoentError } })))
      .toMatchObject({ kind: "missing" });
  });

  it("reports error when spawn fails (non-ENOENT)", async () => {
    const timeoutError = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    expect(await probeCodex("codex.exe", runner({ "--version": { status: null, error: timeoutError } })))
      .toEqual({ kind: "error", detail: "spawn" });
  });

  it("reports too_old with the detected version", async () => {
    expect(await probeCodex("codex.exe", runner({ "--version": { status: 0, stdout: "codex-cli 0.100.0" } })))
      .toEqual({ kind: "too_old", detail: "0.152.0", detectedVersion: "0.100.0" });
  });

  it("reports unauthenticated when login status fails", async () => {
    expect(await probeCodex("codex.exe", runner({
      "--version": { status: 0, stdout: "codex-cli 0.152.1" },
      "login status": { status: 1 },
    }))).toEqual({ kind: "unauthenticated", detail: "codex login", detectedVersion: "0.152.1" });
  });

  it("reports available", async () => {
    expect(await probeCodex("codex.exe", runner({
      "--version": { status: 0, stdout: "codex-cli 0.152.1" },
      "login status": { status: 0, stdout: "Logged in" },
    }))).toEqual({ kind: "available", version: "0.152.1" });
  });
});
