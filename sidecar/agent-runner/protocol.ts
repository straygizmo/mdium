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

/** An invalid inbound line that belongs to a session, so the error can be routed to it. */
export class InboundError extends Error {
  constructor(message: string, readonly sessionId?: string) {
    super(message);
    this.name = "InboundError";
  }
}

/** Most images one turn may carry. */
export const MAX_IMAGES = 10;
const IMAGE_MIME_TYPES: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Mime type of an image path by extension; undefined for unsupported extensions. */
export function imageMimeType(file: string): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | undefined {
  const dot = file.lastIndexOf(".");
  return dot < 0 ? undefined : IMAGE_MIME_TYPES[file.slice(dot).toLowerCase()];
}

function isImageFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Validate a send's image list: at most MAX_IMAGES non-empty absolute paths of existing
 * regular files with an image extension. Returns undefined for a missing or empty list.
 */
function images(value: unknown, sessionId: string): string[] | undefined {
  if (value === undefined) return undefined;
  const valid =
    Array.isArray(value) &&
    value.length <= MAX_IMAGES &&
    value.every(
      (file) => typeof file === "string" && file.trim() !== "" && isAbsolutePath(file) && imageMimeType(file) !== undefined && isImageFile(file),
    );
  if (!valid) throw new InboundError("INVALID_IMAGES", sessionId);
  return value.length > 0 ? (value as string[]) : undefined;
}

/** True when `child` is `root` itself or lies below it (both already resolved). */
function isInside(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  const escapes = relative === ".." || relative.startsWith(`..${path.sep}`);
  return !escapes && !path.isAbsolute(relative);
}

/**
 * True when every image resolves (symlinks followed) to a location inside `root`.
 * An unresolvable root or image counts as outside.
 */
export function imagesWithinRoot(files: readonly string[], root: string): boolean {
  let resolvedRoot: string;
  try {
    resolvedRoot = fs.realpathSync.native(root);
  } catch {
    return false;
  }
  return files.every((file) => {
    try {
      return isInside(fs.realpathSync.native(file), resolvedRoot);
    } catch {
      return false;
    }
  });
}

/** Parse and validate one inbound JSON line. Throws on any invalid shape. */
export function parseInbound(line: string): RunnerInbound {
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
      const parsedImages = images(m.images, sessionId);
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
    default:
      throw new Error("Unknown message type");
  }
}
