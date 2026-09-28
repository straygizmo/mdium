import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentPermission, RunnerInbound, RunnerProvider } from "../../src/shared/types/agent-runner";

const PROVIDERS: readonly RunnerProvider[] = ["codex", "copilot", "opencode", "claude"];
const PERMISSIONS: readonly AgentPermission[] = ["cli-default", "read-only", "full-access"];

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${field}`);
  return value;
}

function provider(value: unknown): RunnerProvider {
  if (!PROVIDERS.includes(value as RunnerProvider)) throw new Error("Invalid provider");
  return value as RunnerProvider;
}

/** A Windows drive or UNC path, or a posix absolute path. */
function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]/.test(value) || value.startsWith("/");
}

function guard(value: unknown): { workspaceRoot: string } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("Invalid guard");
  const workspaceRoot = str((value as { workspaceRoot?: unknown }).workspaceRoot, "guard.workspaceRoot");
  // The guard resolves relative paths against the root, so it must not depend on the runner's cwd.
  if (!isAbsolutePath(workspaceRoot)) throw new Error("Invalid guard.workspaceRoot");
  return { workspaceRoot };
}

/** Most images one turn may carry. */
export const MAX_IMAGES = 10;
export type ImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
const IMAGE_MIME_TYPES: Record<string, ImageMimeType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Mime type of an image path by extension; undefined for unsupported extensions. */
export function imageMimeType(file: string): ImageMimeType | undefined {
  const dot = file.lastIndexOf(".");
  return dot < 0 ? undefined : IMAGE_MIME_TYPES[file.slice(dot).toLowerCase()];
}

/**
 * A drive-absolute Windows path or a posix absolute path. UNC and device paths
 * (`\\server\share`, `\\?\`, `//?/`, `\\.\`) are rejected, so no image path makes the
 * runner touch the network or a raw device.
 */
function isLocalAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\/(?![\\/])/.test(value);
}

/** A send as parsed: images that failed the shape check are reported by RunnerCore. */
export type ParsedSend = Extract<RunnerInbound, { type: "send" }> & { invalidImages?: true };
export type ParsedInbound = Exclude<RunnerInbound, { type: "send" }> | ParsedSend;

/**
 * Shape check of a send's image list, without touching the file system: at most
 * MAX_IMAGES non-empty local absolute paths with an image extension. Returns undefined
 * for a missing or empty list and "invalid" otherwise; the file checks run in RunnerCore
 * (imagesWithinRoot) once the session is known.
 */
function images(value: unknown): string[] | "invalid" | undefined {
  if (value === undefined) return undefined;
  const valid =
    Array.isArray(value) &&
    value.length <= MAX_IMAGES &&
    value.every((file) => typeof file === "string" && file.trim() !== "" && isLocalAbsolutePath(file) && imageMimeType(file) !== undefined);
  if (!valid) return "invalid";
  return value.length > 0 ? (value as string[]) : undefined;
}

/** True when `child` is `root` itself or lies below it (both already resolved). */
function isInside(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  const escapes = relative === ".." || relative.startsWith(`..${path.sep}`);
  return !escapes && !path.isAbsolute(relative);
}

/**
 * Resolve every image (symlinks and junctions followed) and check that it lies inside
 * `root`, still has an image extension, and is a regular file. Returns the resolved paths,
 * which are what the adapters read, so a link cannot be swapped after the check; undefined
 * when any image fails or the root cannot be resolved. The root check runs before the
 * file is stat-ed. A hard link cannot be told apart from a regular file: a hard link inside
 * the root to a file elsewhere on the same volume passes, which is acceptable because
 * creating one already needs write access inside the root.
 */
export function imagesWithinRoot(files: readonly string[], root: string): string[] | undefined {
  let resolvedRoot: string;
  try {
    resolvedRoot = fs.realpathSync.native(root);
  } catch {
    return undefined;
  }
  const resolved: string[] = [];
  for (const file of files) {
    try {
      const real = fs.realpathSync.native(file);
      if (!isInside(real, resolvedRoot) || imageMimeType(real) === undefined || !fs.statSync(real).isFile()) return undefined;
      resolved.push(real);
    } catch {
      return undefined;
    }
  }
  return resolved;
}

/** Parse and validate one inbound JSON line. Throws on any invalid shape. */
export function parseInbound(line: string): ParsedInbound {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("Invalid JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid message");
  const m = parsed as Record<string, unknown>;
  switch (m.type) {
    case "probe":
      return { type: "probe", requestId: str(m.requestId, "requestId"), provider: provider(m.provider) };
    case "start_session": {
      if (!PERMISSIONS.includes(m.permission as AgentPermission)) throw new Error("Invalid permission");
      if (m.env !== undefined) {
        if (!m.env || typeof m.env !== "object" || Object.values(m.env).some((v) => typeof v !== "string")) {
          throw new Error("Invalid env");
        }
      }
      if (m.timeoutMs !== undefined && (typeof m.timeoutMs !== "number" || !(m.timeoutMs > 0))) {
        throw new Error("Invalid timeoutMs");
      }
      if (m.model !== undefined && typeof m.model !== "string") throw new Error("Invalid model");
      if (m.resumeNativeId !== undefined) str(m.resumeNativeId, "resumeNativeId");
      const parsedGuard = guard(m.guard);
      return {
        type: "start_session",
        requestId: str(m.requestId, "requestId"),
        sessionId: str(m.sessionId, "sessionId"),
        provider: provider(m.provider),
        workingDirectory: str(m.workingDirectory, "workingDirectory"),
        permission: m.permission as AgentPermission,
        ...(m.model ? { model: m.model as string } : {}),
        ...(m.resumeNativeId ? { resumeNativeId: m.resumeNativeId as string } : {}),
        ...(m.env ? { env: m.env as Record<string, string> } : {}),
        ...(m.timeoutMs ? { timeoutMs: m.timeoutMs as number } : {}),
        ...(parsedGuard ? { guard: parsedGuard } : {}),
      };
    }
    case "send": {
      const sessionId = str(m.sessionId, "sessionId");
      if (typeof m.text !== "string") throw new Error("Invalid text");
      const parsedImages = images(m.images);
      if (parsedImages === "invalid") return { type: "send", sessionId, text: m.text, invalidImages: true };
      return { type: "send", sessionId, text: m.text, ...(parsedImages ? { images: parsedImages } : {}) };
    }
    case "cancel":
      return { type: "cancel", sessionId: str(m.sessionId, "sessionId") };
    case "respond_permission":
      if (typeof m.allow !== "boolean") throw new Error("Invalid allow");
      return {
        type: "respond_permission",
        sessionId: str(m.sessionId, "sessionId"),
        permissionId: str(m.permissionId, "permissionId"),
        allow: m.allow,
      };
    case "list_sessions":
      return {
        type: "list_sessions",
        requestId: str(m.requestId, "requestId"),
        provider: provider(m.provider),
        workingDirectory: str(m.workingDirectory, "workingDirectory"),
      };
    case "close_session":
      return { type: "close_session", sessionId: str(m.sessionId, "sessionId") };
    case "convert_document": {
      const requestId = str(m.requestId, "requestId");
      const inputPath = str(m.inputPath, "inputPath");
      const outputPath = str(m.outputPath, "outputPath");
      if (!isLocalAbsolutePath(inputPath)) throw new Error("Invalid inputPath");
      if (!isLocalAbsolutePath(outputPath) || !outputPath.toLowerCase().endsWith(".md")) {
        throw new Error("Invalid outputPath");
      }
      return { type: "convert_document", requestId, inputPath, outputPath };
    }
    default:
      throw new Error("Unknown message type");
  }
}
