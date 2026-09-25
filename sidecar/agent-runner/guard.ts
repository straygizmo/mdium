/**
 * Runtime safety guard for agents running with full access inside a per-task git worktree
 * (spec 3.7, layer 2).
 *
 * This is a best-effort, defense-in-depth deny list, NOT a sandbox. It inspects the normalized
 * ToolRequest an adapter reports and blocks well-known dangerous operations (remote git changes,
 * forge CLIs, credential access, outbound uploads, system configuration changes, writes outside
 * the worktree). It is designed to produce no false positives on everyday development commands,
 * and it is complemented by environment containment and post-run checks (spec 3.7, layers 3-4).
 *
 * How shell commands are inspected: the command is lexed (quotes, `&&`/`||`/`;`/`|`/`&`,
 * parentheses/braces, redirections) into invocations. Wrappers (`sudo`, `env X=1`, `xargs`, ...)
 * are skipped, and the payload of shell launchers (`bash -c`, `pwsh -Command`, `cmd /c`,
 * `Invoke-Expression`) and `$(...)` substitutions are inspected recursively.
 *
 * Known gaps (by design this list cannot be exhaustive):
 * - Obfuscation: `-EncodedCommand`, base64/char-code decoding, string concatenation, variables
 *   holding command names or paths, aliases defined earlier, scripts written to disk then run.
 * - Unknown environment variables (`$env:TEMP`, `%APPDATA%`) are not expanded, so paths built
 *   from them are treated as relative to the workspace.
 * - Only listed network tools are recognized; interpreters (`node -e`, `python -c`) doing HTTP,
 *   `git send-email`, DNS exfiltration and PowerShell parameter abbreviations (`-Meth Post`) pass.
 * - Output flags of non-writing commands (`Invoke-WebRequest -OutFile C:\x`, `curl -o /x`) are
 *   not checked for the workspace boundary.
 * - Git Bash style `/c/...` paths are mapped to drives on win32, but other posix-style roots
 *   (`/tmp`) are not considered absolute there.
 * - Mentions of credential locations in ordinary arguments (e.g. `cat .env.example`,
 *   `openssl ... -out cert.pem`) are blocked conservatively; git commit/tag messages are exempt.
 * - Writing verbs block any absolute path outside the workspace, including copy sources.
 */
import * as path from "node:path";
import type { GuardRule, ToolRequest } from "../../src/shared/types/agent-runner";

export interface GuardContext {
  workspaceRoot: string;
  homeDir: string;
  platform: NodeJS.Platform;
}

export type GuardVerdict = { ok: true } | { ok: false; rule: GuardRule };

interface Invocation {
  /** Lowercased command name without directory and executable extension. */
  name: string;
  /** Arguments as written (quotes removed), excluding redirections. */
  args: string[];
  /** Output redirection targets (`>` / `>>`). */
  redirects: string[];
}

const MAX_NESTING = 4;

// ---------------------------------------------------------------------------
// Lexing and parsing
// ---------------------------------------------------------------------------

/** Index of the parenthesis closing the one at `open`, or the string length if unbalanced. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return text.length;
}

/** Split a command line into token lists per simple command, collecting `$(...)` payloads. */
function lex(command: string): { segments: string[][]; nested: string[] } {
  const segments: string[][] = [];
  const nested: string[] = [];
  let tokens: string[] = [];
  let token = "";
  let hasToken = false;
  let quote: string | null = null;
  const flushToken = () => {
    if (hasToken) tokens.push(token);
    token = "";
    hasToken = false;
  };
  const flushSegment = () => {
    flushToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "$" && command[i + 1] === "(" && quote !== "'") {
      const end = closingParen(command, i + 1);
      nested.push(command.slice(i + 2, end));
      token += command.slice(i, end + 1);
      hasToken = true;
      i = end;
    } else if (quote) {
      if (c === quote) quote = null;
      else token += c;
    } else if (c === "\"" || c === "'") {
      quote = c;
      hasToken = true;
    } else if (c === "$" && command[i + 1] === "{") {
      const end = command.indexOf("}", i);
      const stop = end < 0 ? command.length : end;
      token += command.slice(i, stop + 1);
      hasToken = true;
      i = stop;
    } else if (c === ">") {
      // A bare file-descriptor prefix (`2>`, `*>`) is not an argument.
      if (/^[\d*]$/.test(token)) hasToken = false;
      flushToken();
      if (command[i + 1] === ">") i++;
      if (command[i + 1] === "&") {
        // `>&1` duplicates a descriptor; there is no target file.
        i++;
        while (/[\d-]/.test(command[i + 1] ?? "")) i++;
      } else {
        tokens.push(">");
      }
    } else if (/\s/.test(c)) {
      flushToken();
    } else if ("&|;(){}`".includes(c)) {
      flushSegment();
      if ((c === "&" || c === "|") && command[i + 1] === c) i++;
    } else {
      token += c;
      hasToken = true;
    }
  }
  flushSegment();
  return { segments, nested };
}

function commandName(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}

const WRAPPERS = new Set(["sudo", "nohup", "time", "exec", "command", "builtin", "call", "xargs", "doas"]);
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

/** Build an invocation from one segment's tokens, skipping env assignments and wrappers. */
function toInvocation(tokens: string[]): Invocation {
  const words: string[] = [];
  const redirects: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === ">") {
      if (i + 1 < tokens.length) redirects.push(tokens[++i]);
    } else {
      words.push(tokens[i]);
    }
  }
  let start = 0;
  while (start < words.length) {
    const name = commandName(words[start]);
    if (ASSIGNMENT.test(words[start]) || WRAPPERS.has(name)) {
      start++;
    } else if (name === "env" && words.slice(start + 1).some((w) => !w.startsWith("-") && !ASSIGNMENT.test(w))) {
      // `env X=1 cmd` runs cmd; bare `env` (dump) falls through as the command itself.
      start++;
      while (start < words.length && (words[start].startsWith("-") || ASSIGNMENT.test(words[start]))) start++;
    } else {
      break;
    }
  }
  const name = start < words.length ? commandName(words[start]) : "";
  const args = words.slice(start + 1).filter((w) => !(name === "env" && ASSIGNMENT.test(w)));
  return { name, args, redirects };
}

/** The command string a shell launcher or `Invoke-Expression` would execute, if any. */
function launcherPayload(inv: Invocation): string | null {
  const { name, args } = inv;
  const after = (index: number) => (index >= 0 ? args.slice(index + 1).join(" ") : null);
  if (["bash", "sh", "zsh", "dash", "ksh"].includes(name)) {
    const index = args.findIndex((a) => /^-[a-z]*c$/.test(a));
    return index >= 0 ? (args[index + 1] ?? null) : null;
  }
  if (name === "pwsh" || name === "powershell") {
    const index = args.findIndex((a) => /^-(c|command)$/i.test(a));
    if (index >= 0) return after(index);
    return args.length && !args[0].startsWith("-") ? args.join(" ") : null;
  }
  if (name === "cmd") return after(args.findIndex((a) => /^\/[ck]$/i.test(a)));
  if (name === "iex" || name === "invoke-expression") return args.join(" ");
  return null;
}

/** Parse a command line into a flat list of invocations, including nested payloads. */
function parseCommand(command: string, depth = 0): Invocation[] {
  if (depth > MAX_NESTING) return [];
  const { segments, nested } = lex(command);
  const result: Invocation[] = [];
  for (const segment of segments) {
    const inv = toInvocation(segment);
    result.push(inv);
    const payload = launcherPayload(inv);
    if (payload !== null) result.push(...parseCommand(payload, depth + 1));
  }
  for (const inner of nested) result.push(...parseCommand(inner, depth + 1));
  return result;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const HOME_PREFIX = /^(?:~|%userprofile%|\$home|\$\{home\}|\$env:userprofile|\$env:home)(?=$|[\\/])/i;
const DEVICE_TARGETS = /^(?:nul|con|\$null|\/dev\/(?:null|stdout|stderr|tty))$/i;
const PARAM_PREFIX = /^--?[A-Za-z][\w-]*[:=](?=.)/;
const PARENT_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

function pathLib(platform: NodeJS.Platform): typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^(["'])(.*)\1$/, "$2");
}

/** Expand home forms and resolve against `base` (the workspace by default), normalizing `..`. */
function normalizePath(p: string, ctx: GuardContext, base = ctx.workspaceRoot): string {
  const lib = pathLib(ctx.platform);
  let value = stripQuotes(p);
  const home = HOME_PREFIX.exec(value);
  if (home) value = lib.join(ctx.homeDir, value.slice(home[0].length));
  else if (ctx.platform === "win32" && /^\/[a-z]\//i.test(value)) value = `${value[1]}:${value.slice(2)}`;
  return lib.resolve(base, value);
}

function isInside(p: string, root: string, platform: NodeJS.Platform): boolean {
  const lib = pathLib(platform);
  const fold = (s: string) => (platform === "win32" ? s.toLowerCase() : s);
  const withSep = (s: string) => (s.endsWith(lib.sep) ? s : s + lib.sep);
  return withSep(fold(lib.resolve(p))).startsWith(withSep(fold(lib.resolve(root))));
}

function isAbsoluteToken(token: string, platform: NodeJS.Platform): boolean {
  if (HOME_PREFIX.test(token)) return true;
  if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(token) || /^\\/.test(token) || /^\/[a-z]\//i.test(token);
  return token.startsWith("/");
}

/** Tokens that look absolute (or escape via `..`), with any `-Param:` / `--opt=` prefix removed. */
function absolutePathTokens(tokens: string[], platform: NodeJS.Platform): string[] {
  return tokens
    .map((t) => stripQuotes(t.startsWith("-") ? t.replace(PARAM_PREFIX, "") : t))
    .filter((t) => !DEVICE_TARGETS.test(t))
    .filter((t) => isAbsoluteToken(t, platform) || PARENT_SEGMENT.test(t));
}

function anyOutside(tokens: string[], ctx: GuardContext, base: string): boolean {
  return absolutePathTokens(tokens, ctx.platform).some(
    (t) => !isInside(normalizePath(t, ctx, base), ctx.workspaceRoot, ctx.platform),
  );
}

// ---------------------------------------------------------------------------
// Rule: credentials
// ---------------------------------------------------------------------------

const CREDENTIAL_PATTERNS: RegExp[] = [
  /(?:^|[/=:])[._](?:ssh|aws|azure|kube|git-credentials|netrc|npmrc)(?=$|\/)/,
  /(?:^|[/=:])\.config\/(?:gh|glab-cli)(?=$|\/)/,
  /(?:^|[/=:])\.docker\/config\.json$/,
  /(?:^|[/=:])id_(?:rsa|ed25519|ecdsa|dsa)\b/,
  /\.(?:pem|pfx|p12)$/,
  /(?:google\/chrome|microsoft\/edge)\/user(?:$| data)/,
  /mozilla\/firefox\/profiles|\.mozilla\/firefox|\.config\/google-chrome|application support\/google\/chrome/,
  /(?:^|[/=:])\.env(?:\.[^/]*)?$/,
];

function mentionsCredentialPath(text: string): boolean {
  const value = stripQuotes(text).replace(/\\/g, "/").toLowerCase();
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

/** Arguments worth scanning for credential paths; commit/tag messages are free text. */
function scannableArgs(inv: Invocation): string[] {
  if (inv.name !== "git") return inv.args;
  const skipped = new Set<number>();
  inv.args.forEach((a, i) => {
    // `-m`, `-am`, `--message <msg>` take the next token; `--message=<msg>` carries it inline.
    if (/^-[a-zA-Z]*m$/.test(a) || a === "--message") skipped.add(i + 1);
    if (a.startsWith("--message=")) skipped.add(i);
  });
  return inv.args.filter((_, i) => !skipped.has(i));
}

function dumpsEnvironment(inv: Invocation): boolean {
  if (["get-childitem", "gci", "dir", "ls", "get-item", "gi"].includes(inv.name)) {
    return inv.args.some((a) => /^env:/i.test(a));
  }
  if (inv.name === "printenv") return true;
  return (inv.name === "env" || inv.name === "set") && inv.args.length === 0;
}

function shellTouchesCredentials(command: string, invocations: Invocation[]): boolean {
  if (/\[(?:system\.)?environment\]::getenvironmentvariables\b/i.test(command)) return true;
  return invocations.some(
    (inv) => dumpsEnvironment(inv) || [...scannableArgs(inv), ...inv.redirects].some(mentionsCredentialPath),
  );
}

// ---------------------------------------------------------------------------
// Rule: git-remote
// ---------------------------------------------------------------------------

const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const GIT_REMOTE_KEYS = /remote\.|url\.|credential/i;

function changesGitRemote(inv: Invocation): boolean {
  if (inv.name !== "git") return false;
  const globals: string[] = [];
  let i = 0;
  while (i < inv.args.length && inv.args[i].startsWith("-")) {
    if (GIT_VALUE_OPTIONS.has(inv.args[i])) globals.push(inv.args[++i] ?? "");
    i++;
  }
  if (globals.some((g) => GIT_REMOTE_KEYS.test(g))) return true;
  const sub = (inv.args[i] ?? "").toLowerCase();
  const rest = inv.args.slice(i + 1);
  if (sub === "push" || sub.startsWith("credential")) return true;
  if (sub === "remote") {
    const action = rest.find((a) => !a.startsWith("-"))?.toLowerCase() ?? "";
    return ["add", "set-url", "rename", "remove", "rm"].includes(action);
  }
  if (sub === "config") {
    const readOnly = rest.some((a) => /^(?:--get(?:-all|-regexp)?|--list|-l|get|list)$/.test(a));
    return !readOnly && rest.some((a) => GIT_REMOTE_KEYS.test(a));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rule: forge-cli
// ---------------------------------------------------------------------------

function usesForgeCli(inv: Invocation): boolean {
  return inv.name === "gh" || inv.name === "glab";
}

// ---------------------------------------------------------------------------
// Rule: network-send
// ---------------------------------------------------------------------------

const SEND_METHOD = /^(?:post|put|patch|delete)$/i;
const POWERSHELL_WEB = new Set(["iwr", "irm", "invoke-webrequest", "invoke-restmethod", "curl", "wget"]);
const REMOTE_TARGET = /^(?:[^@\s/\\]+@[\w.-]+:|[A-Za-z0-9][\w.-]+:(?![\\/]{2})|rsync:\/\/)/;

function methodIsSend(args: string[], flag: RegExp): boolean {
  return args.some((a, i) => {
    const joined = /^([^:=]+)[:=](.+)$/.exec(a);
    if (joined && flag.test(joined[1])) return SEND_METHOD.test(joined[2]);
    return flag.test(a) && SEND_METHOD.test(args[i + 1] ?? "");
  });
}

function curlSends(args: string[]): boolean {
  if (args.some((a) => /^-X(?:POST|PUT|PATCH|DELETE)$/i.test(a))) return true;
  if (args.some((a) => /^--(?:data|form|upload-file|json)/.test(a) || /^-[sSLkvfiI]*[dFT]/.test(a))) return true;
  return methodIsSend(args, /^(?:-X|--request)$/);
}

function wgetSends(args: string[]): boolean {
  return args.some((a) => /^--(?:post-data|post-file|body-data|body-file)/.test(a)) || methodIsSend(args, /^--method$/);
}

function powershellWebSends(args: string[]): boolean {
  if (args.some((a) => /^-(?:body|infile|form)(?:$|:)/i.test(a))) return true;
  return methodIsSend(args, /^-method$/i);
}

function sendsOverNetwork(inv: Invocation): boolean {
  const { name, args } = inv;
  if (name === "curl" && curlSends(args)) return true;
  if (name === "wget" && wgetSends(args)) return true;
  if (POWERSHELL_WEB.has(name) && powershellWebSends(args)) return true;
  if (name === "scp" || name === "rsync") return args.some((a) => !a.startsWith("-") && REMOTE_TARGET.test(a));
  return ["sftp", "ssh", "nc", "ncat", "netcat", "ftp", "tftp", "send-mailmessage"].includes(name);
}

function isTokenBearingUrl(summary: string): boolean {
  return /\?.*(?:token|key|secret|password)=/i.test(summary);
}

// ---------------------------------------------------------------------------
// Rule: system-config
// ---------------------------------------------------------------------------

const REGISTRY_PATH = /^(?:-[\w-]+:)?["']?(?:hklm:|hkcu:|hkcr:|hku:|registry::|hkey_)/i;
const REGISTRY_WRITERS = new Set([
  "set-itemproperty", "sp", "new-itemproperty", "remove-itemproperty", "rp",
  "new-item", "ni", "remove-item", "ri", "set-item", "si",
]);
const ALWAYS_SYSTEM = new Set([
  "setx", "netsh", "bcdedit", "crontab", "launchctl", "new-service", "set-service", "remove-service",
  "register-scheduledtask", "unregister-scheduledtask", "set-scheduledtask",
]);

function firstOperand(args: string[]): string {
  return (args.find((a) => !a.startsWith("-") && !a.startsWith("\\\\")) ?? "").toLowerCase();
}

function changesSystemConfig(inv: Invocation, ctx: GuardContext): boolean {
  const { name, args } = inv;
  if (ALWAYS_SYSTEM.has(name)) return true;
  if (name === "reg") return ["add", "delete", "import", "copy", "restore"].includes(firstOperand(args));
  if (REGISTRY_WRITERS.has(name) && args.some((a) => REGISTRY_PATH.test(a))) return true;
  if (name === "sc") return ["create", "config", "delete", "start", "stop", "failure"].includes(firstOperand(args));
  if (name === "schtasks") return args.some((a) => /^[/-](?:create|change|delete)$/i.test(a));
  if (name === "systemctl") return ["enable", "disable", "start", "stop", "restart", "mask"].includes(firstOperand(args));
  if (["chmod", "chown", "icacls"].includes(name)) return anyOutside(args, ctx, ctx.workspaceRoot);
  return false;
}

// ---------------------------------------------------------------------------
// Rule: outside-workspace
// ---------------------------------------------------------------------------

const WRITE_VERBS = new Set([
  "rm", "rmdir", "del", "erase", "rd", "remove-item", "ri", "unlink",
  "mv", "move", "move-item", "mi", "ren", "rename", "rename-item", "rni",
  "cp", "copy", "copy-item", "cpi", "xcopy", "robocopy", "ln",
  "set-content", "sc", "out-file", "add-content", "ac", "new-item", "ni",
  "mkdir", "md", "touch", "tee", "tee-object",
]);
const CHANGE_DIR = new Set(["cd", "chdir", "set-location", "sl", "pushd", "push-location"]);

function changeDirTarget(inv: Invocation): string | undefined {
  return inv.args.find((a) => !a.startsWith("-") && !/^\/d$/i.test(a));
}

/** Walk invocations in order, tracking `cd` so `..` escapes resolve against the current directory. */
function writesOutsideWorkspace(invocations: Invocation[], ctx: GuardContext): boolean {
  let cwd = ctx.workspaceRoot;
  for (const [index, inv] of invocations.entries()) {
    if (CHANGE_DIR.has(inv.name)) {
      const target = changeDirTarget(inv);
      if (!target || target === "-") continue;
      cwd = normalizePath(target, ctx, cwd);
      // Leaving the worktree and then running anything else is treated as a write risk.
      if (!isInside(cwd, ctx.workspaceRoot, ctx.platform) && index < invocations.length - 1) return true;
      continue;
    }
    if (anyOutside(inv.redirects, ctx, cwd)) return true;
    if (WRITE_VERBS.has(inv.name) && anyOutside(inv.args, ctx, cwd)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function shellViolation(command: string, ctx: GuardContext): GuardRule | null {
  const invocations = parseCommand(command);
  if (shellTouchesCredentials(command, invocations)) return "credentials";
  if (invocations.some(changesGitRemote)) return "git-remote";
  if (invocations.some(usesForgeCli)) return "forge-cli";
  if (invocations.some(sendsOverNetwork)) return "network-send";
  if (/\[(?:system\.)?environment\]::setenvironmentvariable\b/i.test(command)) return "system-config";
  if (invocations.some((inv) => changesSystemConfig(inv, ctx))) return "system-config";
  if (writesOutsideWorkspace(invocations, ctx)) return "outside-workspace";
  return null;
}

function firstViolation(request: ToolRequest, ctx: GuardContext): GuardRule | null {
  if (request.kind === "shell") return shellViolation(request.summary, ctx);
  if (mentionsCredentialPath(request.summary)) return "credentials";
  if (request.kind === "write" && !isInside(normalizePath(request.summary, ctx), ctx.workspaceRoot, ctx.platform)) {
    return "outside-workspace";
  }
  if (request.kind === "network" && isTokenBearingUrl(request.summary)) return "network-send";
  return null;
}

/** Decide whether a tool request may run under the guard (spec 3.7). */
export function checkToolRequest(request: ToolRequest, ctx: GuardContext): GuardVerdict {
  const rule = firstViolation(request, ctx);
  return rule ? { ok: false, rule } : { ok: true };
}
