import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileEntry, ReplacementSettings } from "@/shared/types";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { collectMdPaths, runBulkReplace } from "../bulk-replace";

function dir(name: string, children: FileEntry[]): FileEntry {
  return { name, path: `/root/${name}`, is_dir: true, children };
}
function file(name: string, path = `/root/${name}`): FileEntry {
  return { name, path, is_dir: false, children: null };
}

describe("collectMdPaths", () => {
  it("collects .md files recursively, skipping dot-dirs and node_modules", () => {
    const tree: FileEntry[] = [
      file("a.md"),
      file("b.txt"),
      file("UPPER.MD", "/root/UPPER.MD"),
      dir("sub", [file("c.md", "/root/sub/c.md")]),
      dir(".mdium", [file("x.md", "/root/.mdium/x.md")]),
      dir(".git", [file("y.md", "/root/.git/y.md")]),
      dir("node_modules", [file("z.md", "/root/node_modules/z.md")]),
    ];
    expect(collectMdPaths(tree)).toEqual(["/root/a.md", "/root/UPPER.MD", "/root/sub/c.md"]);
  });
});

describe("runBulkReplace", () => {
  const settings: ReplacementSettings = {
    enabled: true,
    rules: [{ id: "1", from: "秘密", to: "S1", enabled: true }],
  };

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("rewrites files containing matches and reports counts", async () => {
    const contents: Record<string, string> = {
      "/root/a.md": "秘密の話と秘密",
      "/root/b.md": "何もなし",
    };
    const written: Record<string, string> = {};
    invokeMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "read_text_file") return contents[args.path];
      if (cmd === "write_text_file") {
        written[args.path] = args.content;
        return undefined;
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    const summary = await runBulkReplace(["/root/a.md", "/root/b.md"], settings, "forward");
    expect(summary.changedPaths).toEqual(["/root/a.md"]);
    expect(summary.totalReplacements).toBe(2);
    expect(summary.failed).toEqual([]);
    expect(written["/root/a.md"]).toBe("S1の話とS1");
    expect(written["/root/b.md"]).toBeUndefined();
  });

  it("runs reverse direction", async () => {
    const written: Record<string, string> = {};
    invokeMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "read_text_file") return "S1の話";
      if (cmd === "write_text_file") {
        written[args.path] = args.content;
        return undefined;
      }
    });
    const summary = await runBulkReplace(["/root/a.md"], settings, "reverse");
    expect(written["/root/a.md"]).toBe("秘密の話");
    expect(summary.totalReplacements).toBe(1);
  });

  it("collects per-file errors and continues", async () => {
    invokeMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "read_text_file") {
        if (args.path === "/root/bad.md") throw new Error("boom");
        return "秘密";
      }
      if (cmd === "write_text_file") return undefined;
    });
    const summary = await runBulkReplace(["/root/bad.md", "/root/ok.md"], settings, "forward");
    expect(summary.failed).toEqual([{ path: "/root/bad.md", error: expect.stringContaining("boom") }]);
    expect(summary.changedPaths).toEqual(["/root/ok.md"]);
  });
});
