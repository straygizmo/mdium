import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InboundError, imageMimeType, imagesWithinRoot, parseInbound } from "../protocol";

const start = {
  type: "start_session",
  requestId: "r1",
  sessionId: "s1",
  provider: "codex",
  workingDirectory: "C:/work",
  permission: "cli-default",
};

describe("parseInbound", () => {
  it("accepts every valid command", () => {
    expect(parseInbound(JSON.stringify({ type: "probe", requestId: "r", provider: "copilot" })).type).toBe("probe");
    expect(parseInbound(JSON.stringify(start))).toMatchObject({ sessionId: "s1", permission: "cli-default" });
    expect(parseInbound(JSON.stringify({ type: "send", sessionId: "s1", text: "hi" })).type).toBe("send");
    expect(parseInbound(JSON.stringify({ type: "cancel", sessionId: "s1" })).type).toBe("cancel");
    expect(parseInbound(JSON.stringify({ type: "respond_permission", sessionId: "s1", permissionId: "p", allow: true })).type).toBe("respond_permission");
    expect(parseInbound(JSON.stringify({ type: "list_sessions", requestId: "r", provider: "copilot", workingDirectory: "C:/w" })).type).toBe("list_sessions");
    expect(parseInbound(JSON.stringify({ type: "close_session", sessionId: "s1" })).type).toBe("close_session");
  });

  it.each([
    ["non-JSON", "not json"],
    ["unknown type", JSON.stringify({ type: "explode" })],
    ["bad permission", JSON.stringify({ ...start, permission: "workspace-write" })],
    ["empty workingDirectory", JSON.stringify({ ...start, workingDirectory: " " })],
    ["missing sessionId", JSON.stringify({ type: "send", text: "hi" })],
    ["non-string text", JSON.stringify({ type: "send", sessionId: "s1", text: 3 })],
    ["non-boolean allow", JSON.stringify({ type: "respond_permission", sessionId: "s1", permissionId: "p", allow: "yes" })],
    ["non-string env value", JSON.stringify({ ...start, env: { A: 1 } })],
    ["negative timeout", JSON.stringify({ ...start, timeoutMs: -5 })],
  ])("rejects %s", (_name, line) => {
    expect(() => parseInbound(line)).toThrow();
  });

  it("accepts all runner providers and the guard option", () => {
    for (const provider of ["codex", "copilot", "opencode", "claude"]) {
      expect(parseInbound(JSON.stringify({ type: "probe", requestId: "r", provider })).type).toBe("probe");
    }
    expect(parseInbound(JSON.stringify({ ...start, provider: "claude", guard: { workspaceRoot: "C:/wt" } })))
      .toMatchObject({ provider: "claude", guard: { workspaceRoot: "C:/wt" } });
  });

  it.each([
    ["guard without workspaceRoot", JSON.stringify({ ...start, guard: {} })],
    ["guard with empty workspaceRoot", JSON.stringify({ ...start, guard: { workspaceRoot: " " } })],
    ["unknown provider", JSON.stringify({ ...start, provider: "gemini" })],
    ["guard with a relative workspaceRoot", JSON.stringify({ ...start, guard: { workspaceRoot: "wt/task" } })],
    ["guard with a dot workspaceRoot", JSON.stringify({ ...start, guard: { workspaceRoot: "." } })],
    ["guard with a drive-relative workspaceRoot", JSON.stringify({ ...start, guard: { workspaceRoot: "C:wt" } })],
  ])("rejects %s", (_name, line) => {
    expect(() => parseInbound(line)).toThrow();
  });

  it.each(["C:\\wt\\task", "c:/wt", "\\\\server\\share\\wt", "/home/me/wt"])("accepts the absolute workspaceRoot %s", (workspaceRoot) => {
    expect(parseInbound(JSON.stringify({ ...start, guard: { workspaceRoot } }))).toMatchObject({ guard: { workspaceRoot } });
  });
});

describe("parseInbound send images", () => {
  let dir: string;
  let png: string;
  let jpg: string;
  const send = (images: unknown) => JSON.stringify({ type: "send", sessionId: "s1", text: "hi", images });
  const invalid = (line: string) => {
    try {
      parseInbound(line);
    } catch (error) {
      return error;
    }
    throw new Error("expected parseInbound to throw");
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-images-"));
    png = path.join(dir, "shot.png");
    jpg = path.join(dir, "photo.JPEG");
    fs.writeFileSync(png, "png");
    fs.writeFileSync(jpg, "jpg");
    fs.writeFileSync(path.join(dir, "notes.txt"), "txt");
    fs.mkdirSync(path.join(dir, "folder.png"));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("accepts existing absolute image files", () => {
    expect(parseInbound(send([png, jpg]))).toEqual({ type: "send", sessionId: "s1", text: "hi", images: [png, jpg] });
  });

  it("omits an empty or missing image list", () => {
    expect(parseInbound(send([]))).toEqual({ type: "send", sessionId: "s1", text: "hi" });
    expect(parseInbound(JSON.stringify({ type: "send", sessionId: "s1", text: "hi" }))).toEqual({ type: "send", sessionId: "s1", text: "hi" });
  });

  it.each([
    ["too many images", () => Array.from({ length: 11 }, () => png)],
    ["a relative path", () => ["shot.png"]],
    ["a missing file", () => [path.join(dir, "missing.png")]],
    ["a wrong extension", () => [path.join(dir, "notes.txt")]],
    ["a directory", () => [path.join(dir, "folder.png")]],
    ["an empty path", () => [""]],
    ["a non-string entry", () => [3]],
    ["a non-array value", () => png],
  ])("rejects %s with INVALID_IMAGES for the session", (_name, images) => {
    const error = invalid(send(images()));
    expect(error).toBeInstanceOf(InboundError);
    expect(error).toMatchObject({ message: "INVALID_IMAGES", sessionId: "s1" });
  });

  it("accepts exactly ten images", () => {
    const ten = Array.from({ length: 10 }, () => png);
    expect(parseInbound(send(ten))).toMatchObject({ images: ten });
  });

  it("maps image extensions to mime types", () => {
    expect(imageMimeType("C:/a/b.PNG")).toBe("image/png");
    expect(imageMimeType("/a/b.jpg")).toBe("image/jpeg");
    expect(imageMimeType("/a/b.jpeg")).toBe("image/jpeg");
    expect(imageMimeType("/a/b.gif")).toBe("image/gif");
    expect(imageMimeType("/a/b.webp")).toBe("image/webp");
  });

  it("checks that images resolve inside a root", () => {
    expect(imagesWithinRoot([png, jpg], dir)).toBe(true);
    expect(imagesWithinRoot([png], path.join(dir, "folder.png"))).toBe(false);
    expect(imagesWithinRoot([png], path.join(dir, "no-such-root"))).toBe(false);
  });

  it("rejects a symlink inside the root that points outside it", (ctx) => {
    const root = path.join(dir, "root");
    fs.mkdirSync(root, { recursive: true });
    const link = path.join(root, "link.png");
    try {
      fs.symlinkSync(png, link, "file");
    } catch {
      // Creating symlinks needs a privilege on Windows; nothing to check without one.
      ctx.skip();
    }
    expect(imagesWithinRoot([link], root)).toBe(false);
  });
});
