import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startOpencodeServer } from "../opencode-server";

/** Minimal stand-in for a spawned `opencode serve` process (no pid, so no taskkill). */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn(() => {
    this.signalCode = "SIGTERM";
    return true;
  });

  exit(code: number): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

function fakeSpawn() {
  const child = new FakeChild();
  const spawnImpl = vi.fn((..._args: unknown[]) => child as unknown as ChildProcess);
  return { child, spawnImpl: spawnImpl as unknown as typeof spawn & typeof spawnImpl };
}

type SpawnOptions = { windowsHide?: boolean; stdio?: unknown; env?: NodeJS.ProcessEnv };

function spawnOptions(spawnImpl: { mock: { calls: unknown[][] } }): SpawnOptions {
  return spawnImpl.mock.calls[0][2] as SpawnOptions;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startOpencodeServer", () => {
  it("resolves with the URL from the listening line", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const starting = startOpencodeServer({ config: { share: "disabled" }, spawnImpl });
    child.stdout.write("some banner\nopencode server listening on http://127.0.0.1:4567\n");
    const server = await starting;
    expect(server.url).toBe("http://127.0.0.1:4567");
    expect(server.password).toMatch(/^[0-9a-f]{32}$/);
  });

  it("finds a listening line split across chunks", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const starting = startOpencodeServer({ config: {}, spawnImpl });
    child.stdout.write("opencode server listen");
    child.stdout.write("ing on http://127.0.0.1:9");
    child.stdout.write("876\n");
    await expect(starting).resolves.toMatchObject({ url: "http://127.0.0.1:9876" });
  });

  it("runs `opencode serve` on an OS-assigned loopback port", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const starting = startOpencodeServer({ config: {}, spawnImpl });
    child.stdout.write("opencode server listening on http://127.0.0.1:1\n");
    await starting;
    const [command, args] = spawnImpl.mock.calls[0] as [string, string[]];
    const commandLine = [command, ...args].join(" ");
    expect(commandLine).toContain("opencode serve --hostname=127.0.0.1 --port=0");
  });

  it("spawns hidden with piped output, the config, a random password, and project config disabled", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const config = { share: "disabled", formatter: false };
    const starting = startOpencodeServer({ config, spawnImpl });
    child.stdout.write("opencode server listening on http://127.0.0.1:1\n");
    const server = await starting;
    const options = spawnOptions(spawnImpl);
    expect(options.windowsHide).toBe(true);
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(options.env?.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    expect(options.env?.OPENCODE_CONFIG_CONTENT).toBe(JSON.stringify(config));
    expect(options.env?.OPENCODE_SERVER_PASSWORD).toMatch(/^[0-9a-f]{32}$/);
    expect(options.env?.OPENCODE_SERVER_PASSWORD).toBe(server.password);
    expect(options.env?.PATH ?? options.env?.Path).toBe(process.env.PATH ?? process.env.Path);
  });

  it("uses a different password for each server", async () => {
    const first = fakeSpawn();
    const second = fakeSpawn();
    const a = startOpencodeServer({ config: {}, spawnImpl: first.spawnImpl });
    const b = startOpencodeServer({ config: {}, spawnImpl: second.spawnImpl });
    first.child.stdout.write("opencode server listening on http://127.0.0.1:1\n");
    second.child.stdout.write("opencode server listening on http://127.0.0.1:2\n");
    expect((await a).password).not.toBe((await b).password);
  });

  it("rejects when the process exits before listening", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const starting = startOpencodeServer({ config: {}, spawnImpl });
    child.stderr.write("Failed to start server\n");
    await new Promise((resolve) => setImmediate(resolve));
    child.exit(1);
    await expect(starting).rejects.toThrow(/Server exited with code 1[\s\S]*Failed to start server/);
  });

  it("rejects when the process cannot be spawned", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const starting = startOpencodeServer({ config: {}, spawnImpl });
    child.emit("error", Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" }));
    await expect(starting).rejects.toThrow("ENOENT");
  });

  it("rejects and kills the process on timeout", async () => {
    vi.useFakeTimers();
    const { child, spawnImpl } = fakeSpawn();
    const starting = startOpencodeServer({ config: {}, spawnImpl, timeoutMs: 1_000 });
    const assertion = expect(starting).rejects.toThrow(/Timeout/);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(child.kill).toHaveBeenCalled();
  });

  it("close() kills the running server", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const starting = startOpencodeServer({ config: {}, spawnImpl });
    child.stdout.write("opencode server listening on http://127.0.0.1:1\n");
    const server = await starting;
    server.close();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("close() does nothing once the server has exited", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const starting = startOpencodeServer({ config: {}, spawnImpl });
    child.stdout.write("opencode server listening on http://127.0.0.1:1\n");
    const server = await starting;
    child.exit(0);
    server.close();
    expect(child.kill).not.toHaveBeenCalled();
  });
});
