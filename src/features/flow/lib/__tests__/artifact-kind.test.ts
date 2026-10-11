import { describe, expect, it, vi, afterEach } from "vitest";
import { artifactKind, fetchTextHead, prettyJson, TEXT_PREVIEW_BYTES } from "../artifact-kind";

describe("artifactKind", () => {
  it.each([
    ["image/png", "image"], ["image/webp", "image"], ["video/mp4", "video"], ["audio/wav", "audio"],
    ["application/json", "json"], ["text/plain", "text"], ["text/markdown", "text"], ["application/octet-stream", "other"], ["", "other"],
  ] as const)("%s → %s", (media, kind) => expect(artifactKind(media)).toBe(kind));
});

describe("fetchTextHead", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("requests a byte range and returns the text", async () => {
    const fetchMock = vi.fn(async () => new Response("hello", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchTextHead("asset://x")).resolves.toEqual({ text: "hello", truncated: false });
    expect(fetchMock).toHaveBeenCalledWith("asset://x", { headers: { Range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` } });
  });
  it("marks a 206 response as truncated when the total exceeds the limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("head", { status: 206, headers: { "Content-Range": `bytes 0-3/${TEXT_PREVIEW_BYTES * 2}` } })));
    await expect(fetchTextHead("asset://x")).resolves.toEqual({ text: "head", truncated: true });
  });
  it("cuts a full body longer than the limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("a".repeat(10), { status: 200 })));
    await expect(fetchTextHead("asset://x", 4)).resolves.toEqual({ text: "aaaa", truncated: true });
  });
  it("rejects on a failed response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    await expect(fetchTextHead("asset://x")).rejects.toThrow();
  });
});

describe("prettyJson", () => {
  it("formats valid json and rejects the rest", () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson("{nope")).toBeNull();
  });
});
