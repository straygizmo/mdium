/**
 * Runtime safety guard for agents running with full access inside a per-task git worktree
 * (spec 3.7, layer 2).
 *
 * This is a best-effort, defense-in-depth deny list, NOT a sandbox. It inspects the normalized
 * ToolRequest an adapter reports and blocks well-known dangerous operations (remote git changes,
 * forge CLIs, credential access, outbound uploads and publishing, system configuration changes,
 * writes outside the worktree). It is designed to produce no false positives on everyday
 * development commands, and it is complemented by environment containment and post-run checks
 * (spec 3.7, layers 3-4).
 *
 * How shell commands are inspected: the command is lexed (quotes, newlines, `&&`/`||`/`;`/`|`/`&`,
 * parentheses/braces, redirections; PowerShell backtick and posix backslash line continuations are
 * joined) into invocations. Wrappers (`sudo`, `env X=1`, `xargs`, `timeout`, `wsl`, `npx`,
 * `npm exec`, ...) are skipped, and the payloads of launchers (`bash -c`, `pwsh -Command` /
 * positional / `-EncodedCommand`, `cmd /c`, `Invoke-Expression`, `Start-Process`, `start`,
 * `git submodule foreach`) and `$(...)` substitutions are inspected recursively. An encoded
 * PowerShell command that cannot be decoded is blocked (as `system-config`).
 *
 * Known gaps (by design this list cannot be exhaustive):
 * - Obfuscation: string concatenation, char-code/base64 decoding inside scripts, variables holding
 *   command names or paths, aliases/functions defined earlier, scripts written to disk then run
 *   (`bash x.sh`, `pwsh -File x.ps1`), `npx -c`, git config keys that run commands other than
 *   `alias.*` / `core.sshCommand` (`core.pager`, `core.fsmonitor`, filters).
 * - Unknown environment variables (`$env:TEMP`, `%APPDATA%`) are not expanded, so paths built
 *   from them are treated as relative to the workspace.
 * - Reading a single environment variable (`$env:GH_TOKEN`, `echo $GH_TOKEN`, `Env:GH_TOKEN`) is
 *   allowed; only full environment dumps are blocked. Containment (layer 3) blanks forge tokens.
 * - Network: only listed tools are recognized. Interpreters (`node -e`, `python -c`) doing HTTP,
 *   DNS exfiltration, GET exfiltration via substitution of non-credential data into a URL, and
 *   PowerShell parameter abbreviations (`-Meth Post`) pass.
 * - Writes: output flags of non-writing commands (`Invoke-WebRequest -OutFile C:\x`, `curl -o /x`,
 *   `dd of=/x`), in-place editors (`sed -i /x`), `truncate`, and `find / -delete` are not checked
 *   for the workspace boundary. Writing verbs block any absolute path outside the workspace,
 *   including copy sources.
 * - Git Bash style `/c/...` paths are mapped to drives on win32, but other posix-style roots
 *   (`/tmp`) are not considered absolute there.
 * - Credential locations are matched conservatively in any argument (e.g. `openssl ... -out
 *   cert.pem`); git commit/tag messages are exempt, env templates (`.env.example`, ...) and env
 *   source files (`.env.ts`) are allowed, and writing an env file (copy destination, redirect,
 *   `Set-Content`) is allowed. `.git/config` is allowed (inside the worktree; git needs it).
 */
import * as path from "node:path";
import type { GuardRule, ToolRequest } from "../../src/shared/types/agent-runner";

export interface GuardContext {
  workspaceRoot: string;
  homeDir: string;
  platform: NodeJS.Platform;
  /** Additional directories that count as inside for write checks (e.g. the OS temp dir). */
  extraWritableRoots?: string[];
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
/** Pseudo command produced for an `-EncodedCommand` payload that cannot be decoded. */
const UNDECODABLE = "__guard_undecodable_encoded_command__";

// ---------------------------------------------------------------------------
// Lexing
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

/** Length of a line continuation at `i` (escape char + newline), or 0. */
function continuationLength(command: string, i: number, platform: NodeJS.Platform): number {
  // PowerShell continues lines with a trailing backtick, posix shells with a trailing backslash.
  const escape = platform === "win32" ? "`" : "\\";
  if (command[i] !== escape) return 0;
  if (command[i + 1] === "\n") return 2;
  return command[i + 1] === "\r" && command[i + 2] === "\n" ? 3 : 0;
}

/** Split a command line into token lists per simple command, collecting `$(...)` payloads. */
function lex(command: string, platform: NodeJS.Platform): { segments: string[][]; nested: string[] } {
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
    const continuation = quote ? 0 : continuationLength(command, i, platform);
    if (continuation) {
      flushToken();
      i += continuation - 1;
    } else if (c === "$" && command[i + 1] === "(" && quote !== "'") {
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
    } else if (c === "\n" || "&|;(){}`".includes(c)) {
      flushSegment();
      if ((c === "&" || c === "|") && command[i + 1] === c) i++;
    } else if (/\s/.test(c)) {
      flushToken();
    } else {
      token += c;
      hasToken = true;
    }
  }
  flushSegment();
  return { segments, nested };
}

// ---------------------------------------------------------------------------
// Invocations and wrappers
// ---------------------------------------------------------------------------

function commandName(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}

const ASSIGNMENT = /^[A-Za-z_]\w*=/;

interface WrapperSpec {
  /** Options that consume the following token. */
  valueFlags?: string[];
  /** Required sub-command (e.g. `npm exec`). */
  sub?: string[];
  /** A leading numeric operand (e.g. `timeout 5`). */
  numeric?: boolean;
}

const WRAPPERS = new Map<string, WrapperSpec>([
  ["sudo", { valueFlags: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U"] }],
  ["doas", { valueFlags: ["-u", "-C"] }],
  ["nohup", {}],
  ["time", {}],
  ["exec", { valueFlags: ["-a"] }],
  ["command", {}],
  ["builtin", {}],
  ["call", {}],
  ["xargs", { valueFlags: ["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a"] }],
  ["timeout", { valueFlags: ["-s", "-k", "-t", "--signal", "--kill-after"], numeric: true }],
  ["stdbuf", { valueFlags: ["-i", "-o", "-e"] }],
  ["nice", { valueFlags: ["-n", "--adjustment"] }],
  ["ionice", { valueFlags: ["-c", "-n", "-p", "--class", "--classdata"] }],
  ["wsl", { valueFlags: ["-d", "--distribution", "-u", "--user", "--cd"] }],
  ["npx", { valueFlags: ["-p", "--package"] }],
  ["bunx", { valueFlags: ["-p", "--package"] }],
  ["npm", { sub: ["exec", "x"], valueFlags: ["-p", "--package", "-w", "--workspace"] }],
  ["pnpm", { sub: ["dlx", "exec"], valueFlags: ["--package"] }],
  ["yarn", { sub: ["dlx", "exec"], valueFlags: ["-p", "--package"] }],
]);

function skipOptions(words: string[], start: number, valueFlags: string[]): number {
  let j = start;
  while (j < words.length && words[j].startsWith("-")) {
    if (words[j] === "--") return j + 1;
    if (valueFlags.includes(words[j])) j++;
    j++;
  }
  return j;
}

/** Index of the command `env` runs, or -1 for a bare `env` (which dumps the environment). */
function envCommandStart(words: string[], i: number): number {
  let j = i + 1;
  while (j < words.length && (words[j].startsWith("-") || ASSIGNMENT.test(words[j]))) {
    if (["-u", "-C", "--unset", "--chdir"].includes(words[j])) j++;
    j++;
  }
  return j < words.length ? j : -1;
}

/** Index after the wrapper at `i` (and its options), or -1 when `words[i]` is not a wrapper. */
function skipWrapper(words: string[], i: number): number {
  if (ASSIGNMENT.test(words[i])) return i + 1;
  const name = commandName(words[i]);
  if (name === "env") return envCommandStart(words, i);
  const spec = WRAPPERS.get(name);
  if (!spec) return -1;
  let j = i + 1;
  if (spec.sub) {
    if (!spec.sub.includes((words[j] ?? "").toLowerCase())) return -1;
    j++;
  }
  j = skipOptions(words, j, spec.valueFlags ?? []);
  if (spec.numeric && /^\d/.test(words[j] ?? "")) j++;
  return j;
}

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
    const next = skipWrapper(words, start);
    if (next < 0) break;
    start = next;
  }
  const name = start < words.length ? commandName(words[start]) : "";
  return { name, args: words.slice(start + 1), redirects };
}

// ---------------------------------------------------------------------------
// Launchers
// ---------------------------------------------------------------------------

const POSIX_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const START_PROCESS = new Set(["start-process", "saps", "start"]);
const START_PROCESS_SWITCHES = new Set(["-nonewwindow", "-wait", "-passthru", "-usenewenvironment"]);
const PS_VALUE_FLAGS = [
  "-executionpolicy", "-windowstyle", "-version", "-configurationname", "-inputformat",
  "-outputformat", "-psconsolefile", "-workingdirectory", "-settingsfile", "-custompipename",
];
const PS_VALUE_ALIASES = new Set(["-ep", "-ex", "-w", "-v", "-wd", "-if", "-of", "-config"]);

function isAbbreviation(arg: string, full: string, minLength: number): boolean {
  return arg.length >= minLength && full.startsWith(arg);
}

/** Decode a PowerShell `-EncodedCommand` value (base64 of UTF-16LE). */
function decodeEncodedCommand(value: string): string {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return UNDECODABLE;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length % 2 !== 0) return UNDECODABLE;
  const text = bytes.toString("utf16le");
  return /[\x00-\x08\x0e-\x1f\ufffd]/.test(text) ? UNDECODABLE : text;
}

function powershellPayload(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i].toLowerCase();
    if (!a.startsWith("-")) return args.slice(i).join(" ");
    if (isAbbreviation(a, "-command", 2)) return args.slice(i + 1).join(" ");
    if (a === "-e" || a === "-ec" || isAbbreviation(a, "-encodedcommand", 3)) {
      return decodeEncodedCommand(args[i + 1] ?? "");
    }
    if (isAbbreviation(a, "-file", 2)) return null;
    if (PS_VALUE_ALIASES.has(a) || PS_VALUE_FLAGS.some((f) => isAbbreviation(a, f, 4))) i++;
  }
  return null;
}

/** Commands `Start-Process` / `start` would run. */
function startProcessPayloads(name: string, args: string[]): string[] {
  const positional: string[] = [];
  let file: string | undefined;
  const extra: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const lower = args[i].toLowerCase();
    if (/^\/[a-z]+$/i.test(args[i])) continue; // cmd `start /b /wait` switches
    if (lower === "-filepath") file = args[++i];
    else if (lower === "-argumentlist" || lower === "-args") extra.push(args[++i] ?? "");
    else if (lower.startsWith("-")) {
      if (!START_PROCESS_SWITCHES.has(lower)) i++;
    } else if (args[i]) positional.push(args[i]);
  }
  const parts = [...(file ? [file] : []), ...positional, ...extra].map((p) => p.replace(/,/g, " "));
  if (!parts.length) return [];
  // cmd's `start` treats a leading quoted argument as the window title, so also try without it.
  return name === "start" ? [parts.join(" "), parts.slice(1).join(" ")] : [parts.join(" ")];
}

/** Position of the git sub-command after global options, plus the global option values. */
function gitSubcommand(args: string[]): { sub: string; rest: string[]; globals: string[] } {
  const globals: string[] = [];
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    if (GIT_VALUE_OPTIONS.has(args[i])) globals.push(args[++i] ?? "");
    i++;
  }
  return { sub: (args[i] ?? "").toLowerCase(), rest: args.slice(i + 1), globals };
}

function submoduleForeachPayload(args: string[]): string | null {
  const { sub, rest } = gitSubcommand(args);
  if (sub !== "submodule") return null;
  const index = rest.findIndex((a) => !a.startsWith("-"));
  if (rest[index] !== "foreach") return null;
  return skipOptionsList(rest.slice(index + 1)).join(" ");
}

function skipOptionsList(words: string[]): string[] {
  return words.slice(skipOptions(words, 0, []));
}

/** The command strings a launcher would execute, if any. */
function launcherPayloads(inv: Invocation): string[] {
  const { name, args } = inv;
  const single = (payload: string | null | undefined) => (payload == null ? [] : [payload]);
  if (POSIX_SHELLS.has(name)) {
    const index = args.findIndex((a) => /^-[a-z]*c$/.test(a));
    return index >= 0 ? single(args[index + 1]) : [];
  }
  if (name === "pwsh" || name === "powershell") return single(powershellPayload(args));
  if (name === "cmd") {
    const index = args.findIndex((a) => /^\/[ck]$/i.test(a));
    return index >= 0 ? [args.slice(index + 1).join(" ")] : [];
  }
  if (name === "iex" || name === "invoke-expression") return [args.join(" ")];
  if (START_PROCESS.has(name)) return startProcessPayloads(name, args);
  if (name === "git") return single(submoduleForeachPayload(args));
  return [];
}

/** Parse a command line into a flat list of invocations, including nested payloads. */
function parseCommand(command: string, platform: NodeJS.Platform, depth = 0): Invocation[] {
  if (depth > MAX_NESTING) return [];
  const { segments, nested } = lex(command, platform);
  const result: Invocation[] = [];
  for (const segment of segments) {
    const inv = toInvocation(segment);
    result.push(inv);
    for (const payload of launcherPayloads(inv)) result.push(...parseCommand(payload, platform, depth + 1));
  }
  for (const inner of nested) result.push(...parseCommand(inner, platform, depth + 1));
  return result;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const HOME_PREFIX =
  /^(?:~|%userprofile%|\$home|\$\{home\}|\$env:userprofile|\$env:home|\$\{env:userprofile\}|\$\{env:home\})(?=$|[\\/])/i;
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

/** Inside the workspace or one of the extra writable roots. */
function isWritable(p: string, ctx: GuardContext): boolean {
  return [ctx.workspaceRoot, ...(ctx.extraWritableRoots ?? [])].some((root) => isInside(p, root, ctx.platform));
}

function isAbsoluteToken(token: string, platform: NodeJS.Platform): boolean {
  if (HOME_PREFIX.test(token)) return true;
  if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(token) || /^\\/.test(token) || /^\/[a-z]\//i.test(token);
  return token.startsWith("/");
}

/**
 * Tokens that look absolute (or escape via `..`), with any `-Param:` / `--opt=` prefix removed and
 * PowerShell comma-separated arrays split.
 */
function absolutePathTokens(tokens: string[], platform: NodeJS.Platform): string[] {
  return tokens
    .map((t) => (t.startsWith("-") ? t.replace(PARAM_PREFIX, "") : t))
    .flatMap((t) => t.split(","))
    .map(stripQuotes)
    .filter((t) => !DEVICE_TARGETS.test(t))
    .filter((t) => isAbsoluteToken(t, platform) || PARENT_SEGMENT.test(t));
}

function anyOutside(tokens: string[], ctx: GuardContext, base: string): boolean {
  return absolutePathTokens(tokens, ctx.platform).some((t) => !isWritable(normalizePath(t, ctx, base), ctx));
}

// ---------------------------------------------------------------------------
// Rule: credentials
// ---------------------------------------------------------------------------

const CREDENTIAL_PATTERNS: RegExp[] = [
  /(?:^|[/=:])(?:\.(?:ssh|aws|azure|kube|git-credentials|netrc|npmrc)|_netrc)(?=$|\/)/,
  /(?:^|[/=:])\.config\/(?:gh|glab-cli)(?=$|\/)/,
  /(?:^|[/=:])\.docker\/config\.json$/,
  /(?:^|[/=:])id_(?:rsa|ed25519|ecdsa|dsa)\b/,
  /\.(?:pem|pfx|p12)$/,
  /(?:google\/chrome|microsoft\/edge)\/user(?:$| data)/,
  /mozilla\/firefox\/profiles|\.mozilla\/firefox|\.config\/google-chrome|application support\/google\/chrome/,
  /^\/proc\/[^/]+\/environ$/,
];
const ENV_FILE = /(?:^|[/=:])\.env(\.[^/]*)?$/;
const ENV_NON_SECRET_SUFFIX = /\.(?:example|sample|template|dist|defaults|[cm]?[jt]sx?)$/;
const ENV_FILE_WRITERS = new Set([
  "touch", "new-item", "ni", "set-content", "sc", "out-file", "add-content", "ac", "tee", "tee-object",
]);
const COPY_VERBS = new Set(["cp", "copy", "copy-item", "cpi"]);

function matchable(text: string): string {
  return stripQuotes(text).replace(/\\/g, "/").toLowerCase();
}

function isCredentialPath(text: string): boolean {
  const value = matchable(text);
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

/** `.env`, `.env.local`, `.env.production`, ... but not templates or source files. */
function isSecretEnvFile(text: string): boolean {
  const match = ENV_FILE.exec(matchable(text));
  return !!match && !(match[1] && ENV_NON_SECRET_SUFFIX.test(match[1]));
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

/** Arguments that are only written to (so naming an env file there does not read secrets). */
function envWriteTargets(inv: Invocation): Set<string> {
  if (ENV_FILE_WRITERS.has(inv.name)) return new Set(inv.args);
  if (!COPY_VERBS.has(inv.name)) return new Set();
  const destination = inv.args.findIndex((a) => /^-destination$/i.test(a));
  if (destination >= 0) return new Set(inv.args.slice(destination + 1, destination + 2));
  const positional = inv.args.filter((a) => !a.startsWith("-"));
  return new Set(positional.length >= 2 ? positional.slice(-1) : []);
}

function dumpsEnvironment(inv: Invocation): boolean {
  const { name, args } = inv;
  if (["get-childitem", "gci", "dir", "ls", "get-item", "gi"].includes(name)) {
    return args.some((a) => /^env:[\\/]?$/i.test(a) || (/^env:/i.test(a) && /[*?]/.test(a)));
  }
  if (name === "printenv" || name === "env") return true; // `env` here is bare (no command to run)
  if (name === "set") return args.length === 0;
  if (["export", "declare", "typeset"].includes(name)) return args.every((a) => a.startsWith("-"));
  return false;
}

function readsCredentials(inv: Invocation): boolean {
  const writeTargets = envWriteTargets(inv);
  return (
    scannableArgs(inv).some((a) => isCredentialPath(a) || (isSecretEnvFile(a) && !writeTargets.has(a))) ||
    inv.redirects.some(isCredentialPath)
  );
}

function shellTouchesCredentials(command: string, invocations: Invocation[]): boolean {
  if (/\[(?:system\.)?environment\]::getenvironmentvariables\b/i.test(command)) return true;
  return invocations.some((inv) => dumpsEnvironment(inv) || readsCredentials(inv));
}

// ---------------------------------------------------------------------------
// Rule: git-remote
// ---------------------------------------------------------------------------

const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const GIT_REMOTE_KEYS = /remote\.|url\.|credential|alias\.|core\.sshcommand/i;

function changesGitRemote(inv: Invocation): boolean {
  if (inv.name !== "git") return false;
  const { sub, rest, globals } = gitSubcommand(inv.args);
  if (globals.some((g) => GIT_REMOTE_KEYS.test(g))) return true;
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
const TOKEN_PARAM = /[?&#](?:[\w-]*_)?(?:token|key|secret|password|pw|auth|authorization|access_token|api_key)=/i;

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

function isTokenBearingUrl(url: string): boolean {
  return TOKEN_PARAM.test(url);
}

function publishes(inv: Invocation): boolean {
  const { name, args } = inv;
  const has = (word: string) => args.includes(word);
  if (["npm", "pnpm", "yarn", "cargo"].includes(name)) return has("publish");
  if (["docker", "podman", "gem"].includes(name)) return has("push");
  if (name === "twine") return has("upload");
  if (name === "dotnet") return has("nuget") && has("push");
  return name === "git" && gitSubcommand(args).sub === "send-email";
}

function sendsOverNetwork(inv: Invocation): boolean {
  const { name, args } = inv;
  if (name === "curl" && curlSends(args)) return true;
  if (name === "wget" && wgetSends(args)) return true;
  if (POWERSHELL_WEB.has(name)) {
    if (powershellWebSends(args)) return true;
    if (args.some((a) => /https?:\/\//i.test(a) && isTokenBearingUrl(a))) return true;
  }
  if (name === "scp" || name === "rsync") return args.some((a) => !a.startsWith("-") && REMOTE_TARGET.test(a));
  if (publishes(inv)) return true;
  return ["sftp", "ssh", "nc", "ncat", "netcat", "ftp", "tftp", "send-mailmessage"].includes(name);
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
  "register-scheduledtask", "unregister-scheduledtask", "set-scheduledtask", UNDECODABLE,
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
  "cp", "copy", "copy-item", "cpi", "xcopy", "robocopy", "ln", "mklink",
  "set-content", "sc", "out-file", "add-content", "ac", "new-item", "ni",
  "mkdir", "md", "touch", "tee", "tee-object",
]);
const CHANGE_DIR = new Set(["cd", "chdir", "set-location", "sl", "pushd", "push-location"]);
const DOTNET_IO_CALL = /\[(?:system\.)?io\.(?:file|directory)\]::(\w+)\s*\(([^)]*)\)/gi;
const DOTNET_WRITE_METHOD = /^(?:write|append|create|delete|move|copy|replace|openwrite|setattributes|encrypt|decrypt)/i;

function changeDirTarget(inv: Invocation): string | undefined {
  return inv.args.find((a) => !a.startsWith("-") && !/^\/d$/i.test(a));
}

/** `[IO.File]::WriteAllText("C:\x", ...)` and similar static .NET writes. */
function dotnetWritesOutside(command: string, ctx: GuardContext): boolean {
  for (const call of command.matchAll(DOTNET_IO_CALL)) {
    if (!DOTNET_WRITE_METHOD.test(call[1])) continue;
    const literals = [...call[2].matchAll(/"([^"]*)"|'([^']*)'/g)].map((l) => l[1] ?? l[2]);
    if (anyOutside(literals, ctx, ctx.workspaceRoot)) return true;
  }
  return false;
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
      if (!isWritable(cwd, ctx) && index < invocations.length - 1) return true;
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
  const invocations = parseCommand(command, ctx.platform);
  if (shellTouchesCredentials(command, invocations)) return "credentials";
  if (invocations.some(changesGitRemote)) return "git-remote";
  if (invocations.some(usesForgeCli)) return "forge-cli";
  if (invocations.some(sendsOverNetwork)) return "network-send";
  if (/\[(?:system\.)?environment\]::setenvironmentvariable\b/i.test(command)) return "system-config";
  if (invocations.some((inv) => changesSystemConfig(inv, ctx))) return "system-config";
  if (dotnetWritesOutside(command, ctx) || writesOutsideWorkspace(invocations, ctx)) return "outside-workspace";
  return null;
}

function firstViolation(request: ToolRequest, ctx: GuardContext): GuardRule | null {
  const { kind, summary } = request;
  if (kind === "shell") return shellViolation(summary, ctx);
  // Writing an env file does not expose secrets; reading one does.
  if (isCredentialPath(summary) || (kind !== "write" && isSecretEnvFile(summary))) return "credentials";
  if (kind === "write" && !isWritable(normalizePath(summary, ctx), ctx)) return "outside-workspace";
  if (kind === "network" && isTokenBearingUrl(summary)) return "network-send";
  return null;
}

/** Decide whether a tool request may run under the guard (spec 3.7). */
export function checkToolRequest(request: ToolRequest, ctx: GuardContext): GuardVerdict {
  const rule = firstViolation(request, ctx);
  return rule ? { ok: false, rule } : { ok: true };
}
