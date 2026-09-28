import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { imageMimeType, imagesWithinRoot, parseInbound } from "../protocol";

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
  const send = (images: unknown) => JSON.stringify({ type: "send", sessionId: "s1", text: "hi", images });

  it("accepts local absolute image paths without touching the file system", () => {
    const images = ["C:\\p\\missing.png", "c:/p/photo.JPEG", "/home/me/a.webp"];
    expect(parseInbound(send(images))).toEqual({ type: "send", sessionId: "s1", text: "hi", images });
  });

  it("omits an empty or missing image list", () => {
    expect(parseInbound(send([]))).toEqual({ type: "send", sessionId: "s1", text: "hi" });
    expect(parseInbound(JSON.stringify({ type: "send", sessionId: "s1", text: "hi" }))).toEqual({ type: "send", sessionId: "s1", text: "hi" });
  });

  it("accepts exactly ten images", () => {
    const ten = Array.from({ length: 10 }, () => "C:/p/a.png");
    expect(parseInbound(send(ten))).toMatchObject({ images: ten });
  });

  it.each([
    ["too many images", Array.from({ length: 11 }, () => "C:/p/a.png")],
    ["a relative path", ["shot.png"]],
    ["a drive-relative path", ["C:shot.png"]],
    ["a UNC path", ["\\\\server\\share\\a.png"]],
    ["a forward-slash UNC path", ["//server/share/a.png"]],
    ["a device path", ["\\\\?\\C:\\p\\a.png"]],
    ["a forward-slash device path", ["//?/C:/p/a.png"]],
    ["a dot device path", ["\\\\.\\C:\\p\\a.png"]],
    ["a wrong extension", ["C:/p/notes.txt"]],
    ["an empty path", [""]],
    ["a non-string entry", [3]],
    ["a non-array value", "C:/p/a.png"],
  ])("marks %s as invalid images instead of throwing", (_name, images) => {
    expect(parseInbound(send(images))).toEqual({ type: "send", sessionId: "s1", text: "hi", invalidImages: true });
  });

  it("maps image extensions to mime types", () => {
    expect(imageMimeType("C:/a/b.PNG")).toBe("image/png");
    expect(imageMimeType("/a/b.jpg")).toBe("image/jpeg");
    expect(imageMimeType("/a/b.jpeg")).toBe("image/jpeg");
    expect(imageMimeType("/a/b.gif")).toBe("image/gif");
    expect(imageMimeType("/a/b.webp")).toBe("image/webp");
    expect(imageMimeType("/a/b.exe")).toBeUndefined();
  });
});

describe("imagesWithinRoot", () => {
  let dir: string;
  let root: string;
  let png: string;
  let outsideDir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-images-"));
    root = path.join(dir, "root");
    outsideDir = path.join(dir, "outside");
    fs.mkdirSync(path.join(root, "folder.png"), { recursive: true });
    fs.mkdirSync(outsideDir);
    png = path.join(root, "shot.png");
    fs.writeFileSync(png, "png");
    fs.writeFileSync(path.join(root, "notes.txt"), "txt");
    fs.writeFileSync(path.join(outsideDir, "secret.png"), "png");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns the resolved paths of image files inside the root", () => {
    expect(imagesWithinRoot([png], root)).toEqual([fs.realpathSync.native(png)]);
  });

  it.each([
    ["a file outside the root", () => path.join(outsideDir, "secret.png")],
    ["a missing file", () => path.join(root, "missing.png")],
    ["a directory", () => path.join(root, "folder.png")],
  ])("rejects %s", (_name, file) => {
    expect(imagesWithinRoot([file()], root)).toBeUndefined();
  });

  it("rejects everything when the root cannot be resolved", () => {
    expect(imagesWithinRoot([png], path.join(dir, "no-such-root"))).toBeUndefined();
  });

  it("rejects an image reached through a junction that leaves the root", () => {
    const junction = path.join(root, "linked");
    // Junctions need no privilege on Windows; elsewhere the type is ignored and a directory symlink is made.
    fs.symlinkSync(outsideDir, junction, "junction");
    expect(imagesWithinRoot([path.join(junction, "secret.png")], root)).toBeUndefined();
  });

  it("rejects a file symlink inside the root that points outside it", (ctx) => {
    const link = path.join(root, "link.png");
    try {
      fs.symlinkSync(path.join(outsideDir, "secret.png"), link, "file");
    } catch {
      // Creating file symlinks needs a privilege on Windows; nothing to check without one.
      ctx.skip();
    }
    expect(imagesWithinRoot([link], root)).toBeUndefined();
  });

  it("rejects a link whose target is not an image", (ctx) => {
    const link = path.join(root, "renamed.png");
    try {
      fs.symlinkSync(path.join(root, "notes.txt"), link, "file");
    } catch {
      ctx.skip();
    }
    expect(imagesWithinRoot([link], root)).toBeUndefined();
  });
});

describe("parseInbound convert_document", () => {
  const base = { type: "convert_document", requestId: "r", inputPath: "C:/p/a.docx", outputPath: "C:/p/md/a.md" };

  it("accepts local absolute paths with a .md output", () => {
    expect(parseInbound(JSON.stringify(base))).toEqual(base);
    const posix = { ...base, inputPath: "/p/a.pdf", outputPath: "/p/a.MD" };
    expect(parseInbound(JSON.stringify(posix))).toEqual(posix);
  });

  it.each([
    ["relative input", { ...base, inputPath: "a.docx" }],
    ["UNC input", { ...base, inputPath: "//server/share/a.docx" }],
    ["relative output", { ...base, outputPath: "a.md" }],
    ["non-markdown output", { ...base, outputPath: "C:/p/a.txt" }],
    ["missing requestId", { ...base, requestId: "" }],
  ])("rejects %s", (_label, msg) => {
    expect(() => parseInbound(JSON.stringify(msg))).toThrow();
  });
});
