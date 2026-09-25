/**
 * Runtime safety guard for agents running with full access inside a per-task git worktree
 * (spec 3.7, layer 2).
 *
 * This is a best-effort, defense-in-depth deny list, NOT a sandbox. It inspects the normalized
 * ToolRequest an adapter reports and blocks well-known dangerous operations (remote git changes,
 * forge CLIs, credential access, writes to agent/tool or git configuration inside the worktree,
 * outbound uploads and publishing, system configuration changes, writes outside the worktree).
 * It is designed to produce no false positives on everyday development commands, and it is
 * complemented by environment containment and post-run checks (spec 3.7, layers 3-4).
 *
 * How shell commands are inspected: the command is lexed (quotes, newlines, `&&`/`||`/`;`/`|`/`&`,
 * parentheses/braces, redirections `>`/`<`/`<<<`) into invocations, using the escape rules of the
 * request's shell dialect: posix backslash, PowerShell backtick, or cmd caret line continuations
 * are joined and in-word escapes (`pu\sh`, ``p`ush``, `p^ush`) are removed. When the adapter does
 * not know the dialect on Windows (PowerShell or Git Bash), the command is lexed with both posix
 * and PowerShell rules and blocked when either interpretation violates a rule. Payloads of
 * `bash -c`/`pwsh -Command`/`cmd /c` and git-run commands use their launcher's dialect. Heredoc
 * bodies and PowerShell here-strings are data;
 * they are only inspected as commands when fed to a shell (`bash <<EOF`, `cat <<EOF | sh`), as are
 * literals piped into a shell (`echo ... | bash`, `'...' | iex`). Wrappers (`sudo`, `env X=1`,
 * `xargs`, `timeout`, `wsl`, `npx`, `npm exec`, ...) are skipped, and the payloads of launchers
 * (`bash -c`, `pwsh -Command` / positional / `-EncodedCommand`, `cmd /c`, `Invoke-Expression`,
 * `Start-Process`, `start`, `env -S`, `git submodule foreach`), of `$(...)` substitutions, and of
 * command-valued git settings (`git -c`, `GIT_*`/`PAGER`/`EDITOR` variables, `GIT_CONFIG_KEY_n`)
 * are inspected recursively. Undecodable encoded PowerShell commands are blocked (`system-config`)
 * and inputs over 64 KB or with too many segments are blocked (`outside-workspace`). Requests an
 * adapter marks `opaque` (MCP and extension tools, code runners, shell requests without command
 * text) are blocked as `opaque-tool`, since their effects cannot be inspected.
 *
 * Known gaps (by design this list cannot be exhaustive):
 * - Obfuscation: string concatenation, char-code/base64 decoding inside scripts, variables holding
 *   command names or paths, aliases/functions defined earlier, backtick substitution inside double
 *   quotes, `--config-env`, `GIT_CONFIG_PARAMETERS`.
 * - Scripts executed from disk: `bash x.sh`, `pwsh -File x.ps1`, npm scripts, git hooks inside
 *   the worktree, and config values that point at a script file are not inspected.
 * - Unknown environment variables (`$env:TEMP`, `%APPDATA%`) are not expanded, so paths built
 *   from them are treated as relative to the workspace. Globs are not expanded either (a trailing
 *   `*`/`?` is ignored for credential matching only).
 * - Reading a single environment variable (`$env:GH_TOKEN`, `echo $GH_TOKEN`, `Env:GH_TOKEN`) is
 *   allowed; only full environment dumps are blocked. Containment (layer 3) blanks forge tokens.
 * - Env files loaded implicitly by tools (`npm run dev` reading `.env`) pass; naming an env file
 *   in an argument (`--env-file .env`, `dotenv -e .env`) is blocked.
 * - Network: only listed tools are recognized. Interpreters (`node -e`, `python -c`) doing HTTP,
 *   DNS exfiltration, GET exfiltration via substitution of non-credential data into a URL, and
 *   PowerShell parameter abbreviations (`-Meth Post`) pass.
 * - Writes: output flags of non-writing commands (`Invoke-WebRequest -OutFile C:\x`, `curl -o /x`,
 *   `dd of=/x`), in-place editors (`sed -i /x`), `truncate`, `find / -delete`, and .NET stream
 *   writers (`[IO.StreamWriter]::new`, `New-Object IO.StreamWriter`) are not checked for the
 *   workspace boundary. Writing verbs block any absolute path outside the workspace, including copy
 *   sources.
 * - Git Bash style `/c/...` paths are mapped to drives on win32, but other posix-style roots
 *   (`/tmp`) are not considered absolute there.
 * - Credential locations are matched conservatively in any argument (e.g. `openssl ... -out
 *   cert.pem`); git commit/tag messages are exempt, env templates (`.env.example`, ...) and env
 *   source files (`.env.ts`) are allowed, and writing an env file (copy destination, output
 *   redirect, `Set-Content`) is allowed. Reading `.git/config` is allowed (git needs it).
 * - Agent configuration writes (`.claude/`, `.opencode/`, `opencode.json(c)`, `.mcp.json`, `.codex/`,
 *   `.copilot/`, `.vscode/{settings,tasks,mcp}.json`, `.git/`, `.gitmodules`) are only detected for
 *   write requests, write verbs, redirections and static .NET writes; writes by other programs
 *   (`sed -i`, `node -e`, `git config --file`, `git checkout` of such files), 8.3 short names and
 *   symlinks/junctions pointing into those directories pass.
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

interface Token {
  text: string;
  /** The token started with a quote (a string literal rather than a word). */
  quoted: boolean;
  /** Offset in the lexed source. */
  start: number;
  /** Redirection operator (`>`, `<`, `<<<`). */
  op?: boolean;
}

interface Segment {
  tokens: Token[];
  /** Heredoc bodies and here-strings fed to this command's stdin. */
  stdin: string[];
  /** Preceded by a single `|`. */
  piped: boolean;
  source: string;
  end: number;
}

interface Invocation {
  /** Lowercased command name without directory and executable extension. */
  name: string;
  /** Arguments as written (quotes removed), excluding redirections. */
  args: string[];
  argStarts: number[];
  source: string;
  end: number;
  /** Output redirection targets (`>` / `>>`). */
  redirects: string[];
  /** Input redirection sources (`<`). */
  inputs: string[];
  stdin: string[];
  /** Environment assignments made by this segment (`X=1 cmd`, `$env:X=1`, `export X=1`). */
  assignments: [string, string][];
  piped: boolean;
  /** Text this segment writes to stdout when it is a plain literal producer. */
  literal: string | null;
}

interface ParseState {
  budget: number;
  overflow: boolean;
}

const MAX_NESTING = 4;
const MAX_COMMAND_LENGTH = 64 * 1024;
const MAX_SEGMENTS = 10000;
/** Pseudo command produced for an `-EncodedCommand` payload that cannot be decoded. */
const UNDECODABLE = "__guard_undecodable_encoded_command__";

// ---------------------------------------------------------------------------
// Heredocs, here-strings and parentheses
// ---------------------------------------------------------------------------

interface Heredoc {
  delimiter: string;
  /** `-` strips leading tabs, `~` strips leading whitespace. */
  strip: string;
  /** Offset just after the delimiter word. */
  end: number;
}

/** Parse `<<DELIM`, `<<-'DELIM'`, `<<~"DELIM"`, `<<\DELIM` at `i`. */
function heredocStart(text: string, i: number): Heredoc | null {
  let j = i + 2;
  let strip = "";
  if (text[j] === "-" || text[j] === "~") strip = text[j++];
  while (text[j] === " " || text[j] === "\t") j++;
  const word = /^(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z0-9_.-]+))/.exec(text.slice(j, j + 256));
  if (!word) return null;
  return { delimiter: word[1] ?? word[2] ?? word[3], strip, end: j + word[0].length };
}

/** Read a heredoc body starting at `start`; returns the body and the offset after its terminator. */
function readHeredocBody(text: string, start: number, heredoc: Heredoc): { body: string; next: number } {
  const lines: string[] = [];
  let pos = start;
  while (pos < text.length) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = text.length;
    const line = text.slice(pos, end).replace(/\r$/, "");
    pos = end + 1;
    const candidate = heredoc.strip === "-" ? line.replace(/^\t+/, "") : heredoc.strip === "~" ? line.trimStart() : line;
    if (candidate === heredoc.delimiter) return { body: lines.join("\n"), next: pos };
    lines.push(line);
  }
  return { body: lines.join("\n"), next: text.length };
}

/** PowerShell here-string (`@"`/`@'` ending its line, closed by a line starting with `"@`/`'@`). */
function hereString(text: string, i: number): { body: string; end: number; expandable: boolean } | null {
  const quote = text[i + 1];
  const opening = /[ \t\r]*\n/y;
  opening.lastIndex = i + 2;
  if (!opening.exec(text)) return null;
  const lineEnd = opening.lastIndex - 1;
  const closing = quote === "\"" ? /\n[ \t]*"@/g : /\n[ \t]*'@/g;
  closing.lastIndex = lineEnd;
  const match = closing.exec(text);
  const close = match ? match.index : text.length;
  return {
    body: text.slice(lineEnd + 1, close).replace(/\r$/, ""),
    end: match ? match.index + match[0].length : text.length,
    expandable: quote === "\"",
  };
}

/** Index of the parenthesis closing the one at `open` (quote and heredoc aware), or the length. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  let pending: Heredoc[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === "\"") {
      quote = c;
    } else if (c === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
      const heredoc = heredocStart(text, i);
      if (heredoc) {
        pending.push(heredoc);
        i = heredoc.end - 1;
      }
    } else if (c === "\n" && pending.length) {
      let pos = i + 1;
      for (const heredoc of pending) pos = readHeredocBody(text, pos, heredoc).next;
      pending = [];
      i = pos - 1;
    } else if (c === "(") {
      depth++;
    } else if (c === ")" && --depth === 0) {
      return i;
    }
  }
  return text.length;
}

/** Collect `$(...)` payloads inside an expandable string body. */
function collectSubstitutions(text: string, nested: string[]): void {
  for (let i = text.indexOf("$("); i >= 0; i = text.indexOf("$(", i + 2)) {
    const end = closingParen(text, i + 1);
    nested.push(text.slice(i + 2, end));
    i = end;
  }
}

// ---------------------------------------------------------------------------
// Lexing
// ---------------------------------------------------------------------------

const SEPARATORS = "&|;(){}`\n\r\u2028\u2029\u0085";

/** Shell dialect a command line is lexed with. */
type Dialect = NonNullable<ToolRequest["shell"]>;

/** Escape character of each dialect; followed by a newline it continues the line. */
const ESCAPE_CHAR: Record<Dialect, string> = { posix: "\\", powershell: "`", cmd: "^" };

/** Length of a line continuation at `i` (escape char + newline), or 0. */
function continuationLength(command: string, i: number, dialect: Dialect): number {
  if (command[i] !== ESCAPE_CHAR[dialect]) return 0;
  if (command[i + 1] === "\n") return 2;
  return command[i + 1] === "\r" && command[i + 2] === "\n" ? 3 : 0;
}

/**
 * Length of an escape sequence at `i` inside a double-quoted string, or 0: posix escapes only
 * `$`, backtick, `"`, `\` and newlines there; PowerShell escapes any character with a backtick.
 */
function quotedEscapeLength(command: string, i: number, dialect: Dialect): number {
  if (dialect === "powershell") return command[i] === "`" && i + 1 < command.length ? 2 : 0;
  if (dialect !== "posix" || command[i] !== "\\") return 0;
  if ("$`\"\\\n".includes(command[i + 1] ?? "")) return 2;
  return command[i + 1] === "\r" && command[i + 2] === "\n" ? 3 : 0;
}

/** Split a command line into segments (simple commands), collecting `$(...)` payloads. */
function lex(command: string, dialect: Dialect, depth = 0): { segments: Segment[]; nested: string[] } {
  const segments: Segment[] = [];
  const nested: string[] = [];
  const newSegment = (piped: boolean): Segment => ({ tokens: [], stdin: [], piped, source: command, end: 0 });
  let segment = newSegment(false);
  let token = "";
  let tokenStart = -1;
  let tokenQuoted = false;
  let quote: string | null = null;
  let pending: (Heredoc & { target: string[] })[] = [];
  const begin = (i: number, quoted = false) => {
    if (tokenStart >= 0) return;
    tokenStart = i;
    tokenQuoted = quoted;
  };
  const flushToken = () => {
    if (tokenStart >= 0) segment.tokens.push({ text: token, quoted: tokenQuoted, start: tokenStart });
    token = "";
    tokenStart = -1;
    tokenQuoted = false;
  };
  const pushOperator = (text: string, i: number) => {
    flushToken();
    segment.tokens.push({ text, quoted: false, start: i, op: true });
  };
  const flushSegment = (end: number, piped: boolean) => {
    flushToken();
    segment.end = end;
    if (segment.tokens.length || segment.stdin.length) segments.push(segment);
    segment = newSegment(piped);
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const continuation = quote ? 0 : continuationLength(command, i, dialect);
    const quotedEscape = quote === "\"" ? quotedEscapeLength(command, i, dialect) : 0;
    if (continuation) {
      flushToken();
      i += continuation - 1;
    } else if (!quote && c === ESCAPE_CHAR[dialect] && i + 1 < command.length) {
      // An escaped character is literal: `pu\sh`, ``p`ush`` and `p^ush` all name `push`.
      begin(i);
      token += command[++i];
    } else if (quotedEscape) {
      token += command.slice(i + 1, i + quotedEscape).replace(/\r?\n$/, "");
      i += quotedEscape - 1;
    } else if (c === "$" && command[i + 1] === "(" && quote !== "'") {
      const end = closingParen(command, i + 1);
      nested.push(command.slice(i + 2, end));
      begin(i);
      token += command.slice(i, end + 1);
      i = end;
    } else if (quote) {
      if (c === quote) quote = null;
      else token += c;
    } else if (c === "@" && (command[i + 1] === "\"" || command[i + 1] === "'") && hereString(command, i)) {
      const here = hereString(command, i)!;
      begin(i, true);
      token += here.body;
      if (here.expandable) collectSubstitutions(here.body, nested);
      i = here.end - 1;
    } else if (c === "@" && command[i + 1] === "(") {
      // PowerShell array literal: keep its elements as one comma-separated token.
      const end = closingParen(command, i + 1);
      const inner = command.slice(i + 2, end);
      nested.push(inner);
      begin(i);
      token += depth < MAX_NESTING
        ? lex(inner, dialect, depth + 1).segments.flatMap((s) => s.tokens.map((t) => t.text)).join(",")
        : inner;
      i = end;
    } else if (c === "\"" || c === "'") {
      begin(i, true);
      quote = c;
    } else if (c === "$" && command[i + 1] === "{") {
      const end = command.indexOf("}", i);
      const stop = end < 0 ? command.length : end;
      begin(i);
      token += command.slice(i, stop + 1);
      i = stop;
    } else if (c === ">") {
      // A bare file-descriptor prefix (`2>`, `*>`) is not an argument.
      if (/^[\d*]$/.test(token)) tokenStart = -1;
      if (command[i + 1] === ">") i++;
      if (command[i + 1] === "&") {
        // `>&1` duplicates a descriptor; there is no target file.
        flushToken();
        i++;
        while (/[\d-]/.test(command[i + 1] ?? "")) i++;
      } else {
        pushOperator(">", i);
      }
    } else if (c === "<") {
      const heredoc = command[i + 1] === "<" && command[i + 2] !== "<" ? heredocStart(command, i) : null;
      if (heredoc) {
        flushToken();
        pending.push({ ...heredoc, target: segment.stdin });
        i = heredoc.end - 1;
      } else if (command[i + 1] === "<" && command[i + 2] === "<") {
        pushOperator("<<<", i);
        i += 2;
      } else {
        pushOperator("<", i);
      }
    } else if (SEPARATORS.includes(c)) {
      flushSegment(i, c === "|" && command[i + 1] !== "|");
      if ((c === "&" || c === "|") && command[i + 1] === c) i++;
      if (c === "\n" && pending.length) {
        let pos = i + 1;
        for (const heredoc of pending) {
          const read = readHeredocBody(command, pos, heredoc);
          heredoc.target.push(read.body);
          pos = read.next;
        }
        pending = [];
        i = pos - 1;
      }
    } else if (/\s/.test(c)) {
      flushToken();
    } else {
      begin(i);
      token += c;
    }
  }
  flushSegment(command.length, false);
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
const POWERSHELL_ASSIGNMENT = /^\$env:([A-Za-z_]\w*)(?:=([\s\S]*))?$/i;

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

/** Index of the command `env` runs; -1 for a bare `env` (a dump) or `env -S` (a launcher). */
function envCommandStart(words: string[], i: number): number {
  let j = i + 1;
  while (j < words.length && (words[j].startsWith("-") || ASSIGNMENT.test(words[j]))) {
    if (/^(?:-S|--split-string)/.test(words[j])) return -1;
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
  // `command -v gh` only looks the command up.
  if (name === "command" && /^-[vV]$/.test(words[i + 1] ?? "")) return -1;
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

function assignmentPair(word: string): [string, string] {
  const index = word.indexOf("=");
  return [word.slice(0, index), word.slice(index + 1)];
}

/** Environment assignments made by a segment, and whether the segment is only an assignment. */
function segmentAssignments(words: string[], start: number): { pairs: [string, string][]; only: boolean } {
  const pairs = words.slice(0, start).filter((w) => ASSIGNMENT.test(w)).map(assignmentPair);
  const first = words[start] ?? "";
  const powershell = POWERSHELL_ASSIGNMENT.exec(first);
  if (powershell) {
    const value = powershell[2] ?? (words[start + 1] === "=" ? (words[start + 2] ?? "") : undefined);
    if (value !== undefined) pairs.push([powershell[1], value]);
    return { pairs, only: true };
  }
  if (["export", "set", "declare", "typeset"].includes(first.toLowerCase())) {
    pairs.push(...words.slice(start + 1).filter((w) => ASSIGNMENT.test(w)).map(assignmentPair));
  }
  return { pairs, only: false };
}

const LITERAL_PRODUCERS = new Set(["echo", "printf", "write-output"]);

/** Build an invocation from one segment, skipping env assignments and wrappers. */
function toInvocation(segment: Segment): Invocation {
  const words: Token[] = [];
  const redirects: string[] = [];
  const inputs: string[] = [];
  const stdin = [...segment.stdin];
  for (let i = 0; i < segment.tokens.length; i++) {
    const token = segment.tokens[i];
    if (!token.op) {
      words.push(token);
      continue;
    }
    const next = segment.tokens[i + 1];
    if (!next || next.op) continue;
    i++;
    if (token.text === ">") redirects.push(next.text);
    else if (token.text === "<") inputs.push(next.text);
    else stdin.push(next.text);
  }
  const texts = words.map((w) => w.text);
  let start = 0;
  while (start < texts.length) {
    const next = skipWrapper(texts, start);
    if (next < 0) break;
    start = next;
  }
  const { pairs, only } = segmentAssignments(texts, start);
  const name = only || start >= texts.length ? "" : commandName(texts[start]);
  const args = texts.slice(start + 1);
  let literal: string | null = null;
  if (words.length === 1 && words[0].quoted) literal = words[0].text;
  else if (LITERAL_PRODUCERS.has(name)) literal = args.filter((a) => !/^-[neE]+$/.test(a)).join(" ");
  return {
    name,
    args,
    argStarts: words.slice(start + 1).map((w) => w.start),
    source: segment.source,
    end: segment.end,
    redirects,
    inputs,
    stdin,
    assignments: pairs,
    piped: segment.piped,
    literal,
  };
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

function quoteIfSpaced(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

/** Rebuild a command line from arguments; a single argument is the command line itself. */
function joinPayload(args: string[]): string {
  return args.length === 1 ? args[0] : args.map(quoteIfSpaced).join(" ");
}

/** Decode a PowerShell `-EncodedCommand` value (base64 of UTF-16LE). */
function decodeEncodedCommand(value: string): string {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return UNDECODABLE;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length % 2 !== 0) return UNDECODABLE;
  const text = bytes.toString("utf16le");
  return /[\x00-\x08\x0e-\x1f\ufffd]/.test(text) ? UNDECODABLE : text;
}

/** What `powershell`/`pwsh` would run: a payload, a script file (nothing), or stdin. */
function powershellCommand(args: string[]): { payload?: string; stdin?: boolean } {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-") return { stdin: true };
    const flag = /^[-/]([A-Za-z]+)(?::([\s\S]*))?$/.exec(args[i]);
    if (!flag) return { payload: joinPayload(args.slice(i)) };
    const name = `-${flag[1].toLowerCase()}`;
    const inline = flag[2];
    if (isAbbreviation(name, "-command", 2)) {
      const rest = inline !== undefined ? [inline] : args.slice(i + 1);
      return rest.length === 1 && rest[0] === "-" ? { stdin: true } : { payload: joinPayload(rest) };
    }
    if (name === "-cwa" || isAbbreviation(name, "-commandwithargs", 9)) return { payload: inline ?? args[i + 1] ?? "" };
    if (name === "-e" || name === "-ec" || isAbbreviation(name, "-encodedcommand", 3)) {
      return { payload: decodeEncodedCommand(inline ?? args[i + 1] ?? "") };
    }
    if (isAbbreviation(name, "-file", 2)) return {};
    if (inline === undefined && (PS_VALUE_ALIASES.has(name) || PS_VALUE_FLAGS.some((f) => isAbbreviation(name, f, 4)))) i++;
  }
  return { stdin: true };
}

/** `cmd /c <rest>`: the raw rest of the line, with and without cmd's outer-quote stripping. */
function cmdPayloads(inv: Invocation): string[] {
  const index = inv.args.findIndex((a) => /^\/[ck]$/i.test(a));
  if (index < 0 || index + 1 >= inv.args.length) return [];
  const raw = inv.source.slice(inv.argStarts[index + 1], inv.end).trim();
  const stripped = raw.startsWith("\"") ? raw.slice(1).replace(/"([^"]*)$/, "$1") : raw;
  return stripped === raw ? [raw] : [raw, stripped];
}

/** Commands `Start-Process` / `start` would run. */
function startProcessPayloads(name: string, args: string[]): string[] {
  const positional: string[] = [];
  const extra: string[] = [];
  let file: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const lower = args[i].toLowerCase();
    if (/^\/[a-z]+$/i.test(args[i])) continue; // cmd `start /b /wait` switches
    if (lower === "-filepath") file = args[++i];
    else if (lower === "-argumentlist" || lower === "-args") extra.push(args[++i] ?? "");
    else if (/^-[a-z]+$/.test(lower)) {
      if (!START_PROCESS_SWITCHES.has(lower)) i++;
    } else if (args[i]) positional.push(args[i]);
  }
  // Argument strings are parsed by the started program, so they stay unquoted.
  const build = (program: string | undefined, rest: string[]) =>
    program ? [quoteIfSpaced(program), ...rest, ...extra].map((p, k) => (k ? p.replace(/,/g, " ") : p)).join(" ") : null;
  const payloads = [file ? build(file, positional) : build(positional[0], positional.slice(1))];
  // cmd's `start` treats a leading quoted argument as the window title, so also try without it.
  if (name === "start" && !file) payloads.push(build(positional[1], positional.slice(2)));
  return payloads.filter((p): p is string => p !== null);
}

function submoduleForeachPayload(args: string[]): string | null {
  const { sub, rest } = gitSubcommand(args);
  if (sub !== "submodule") return null;
  const index = rest.findIndex((a) => !a.startsWith("-"));
  if (rest[index] !== "foreach") return null;
  const command = rest.slice(skipOptions(rest, index + 1, []));
  return command.length ? joinPayload(command) : null;
}

function envSplitPayload(args: string[]): string[] {
  const index = args.findIndex((a) => /^(?:-S|--split-string)/.test(a));
  if (index < 0) return [];
  const inline = args[index].replace(/^(?:-S|--split-string=?)/, "");
  const rest = inline ? [inline, ...args.slice(index + 1)] : args.slice(index + 1);
  return rest.length ? [rest.join(" ")] : [];
}

/** The command strings a launcher would execute, if any. */
function launcherPayloads(inv: Invocation): string[] {
  const { name, args } = inv;
  if (POSIX_SHELLS.has(name)) {
    const index = args.findIndex((a) => /^-[a-z]*c$/.test(a));
    return index >= 0 && index + 1 < args.length ? [args[index + 1]] : [];
  }
  if (name === "pwsh" || name === "powershell") {
    const payload = powershellCommand(args).payload;
    return payload === undefined ? [] : [payload];
  }
  if (name === "cmd") return cmdPayloads(inv);
  if (name === "iex" || name === "invoke-expression") return args.length ? [joinPayload(args)] : [];
  if (START_PROCESS.has(name)) return startProcessPayloads(name, args);
  if (name === "env") return envSplitPayload(args);
  if (name === "git") {
    const payload = submoduleForeachPayload(args);
    return payload === null ? [] : [payload];
  }
  return [];
}

/** A shell or evaluator that executes what it reads from stdin. */
function readsCommandsFromStdin(inv: Invocation): boolean {
  const { name, args } = inv;
  if (POSIX_SHELLS.has(name)) {
    return !args.some((a) => /^-[a-z]*c$/.test(a)) && args.every((a) => a.startsWith("-"));
  }
  if (name === "pwsh" || name === "powershell") return powershellCommand(args).stdin === true;
  if (name === "iex" || name === "invoke-expression") return args.length === 0;
  if (name === "cmd") return !args.some((a) => /^\/[ck]$/i.test(a));
  return false;
}

/** What a piped-from segment writes to stdout, when it is known text. */
function producedText(inv: Invocation): string[] {
  if (inv.literal !== null) return [inv.literal];
  return ["cat", "type", "get-content", "gc"].includes(inv.name) ? inv.stdin : [];
}

/** Dialect of the commands a launcher runs; other launchers keep the surrounding dialect. */
function payloadDialect(inv: Invocation, inherited: Dialect): Dialect {
  // git runs submodule foreach commands through sh.
  if (POSIX_SHELLS.has(inv.name) || inv.name === "git" || inv.name === "env") return "posix";
  if (["pwsh", "powershell", "iex", "invoke-expression"].includes(inv.name)) return "powershell";
  return inv.name === "cmd" ? "cmd" : inherited;
}

/** Parse a command line into a flat list of invocations, including nested payloads. */
function parseCommand(command: string, dialect: Dialect, state: ParseState, depth = 0): Invocation[] {
  if (depth > MAX_NESTING || state.overflow) return [];
  const { segments, nested } = lex(command, dialect, depth);
  const result: Invocation[] = [];
  let previous: Invocation | null = null;
  for (const segment of segments) {
    if (--state.budget < 0) {
      state.overflow = true;
      return result;
    }
    const inv = toInvocation(segment);
    result.push(inv);
    const payloads = launcherPayloads(inv);
    if (readsCommandsFromStdin(inv)) {
      payloads.push(...inv.stdin);
      if (inv.piped && previous) payloads.push(...producedText(previous));
    }
    const inner = payloadDialect(inv, dialect);
    for (const payload of payloads) result.push(...parseCommand(payload, inner, state, depth + 1));
    previous = inv;
  }
  for (const inner of nested) result.push(...parseCommand(inner, dialect, state, depth + 1));
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

function writableRoots(ctx: GuardContext): string[] {
  return [ctx.workspaceRoot, ...(ctx.extraWritableRoots ?? [])];
}

/** Inside the workspace or one of the extra writable roots. */
function isWritable(p: string, ctx: GuardContext): boolean {
  return writableRoots(ctx).some((root) => isInside(p, root, ctx.platform));
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

function anyOutside(tokens: string[], ctx: GuardContext, base: () => string): boolean {
  const candidates = absolutePathTokens(tokens, ctx.platform);
  return candidates.length > 0 && candidates.some((t) => !isWritable(normalizePath(t, ctx, base()), ctx));
}

const atWorkspace = (ctx: GuardContext) => () => ctx.workspaceRoot;

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

/** Lowercase, `/`-separated, without NTFS stream suffix, trailing globs, dots or spaces. */
function matchable(text: string): string {
  return stripQuotes(text)
    .replace(/\\/g, "/")
    .toLowerCase()
    .replace(/::\$data$/, "")
    .replace(/[*?.\s]+$/, "");
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

/** Destination arguments of a copy command (`-Destination`, `-t`, or the last positional). */
function copyDestinations(args: string[]): string[] {
  const flagged = args.findIndex((a) => /^(?:-destination|-t|--target-directory)$/i.test(a));
  if (flagged >= 0) return args.slice(flagged + 1, flagged + 2);
  const inline = args.find((a) => a.startsWith("--target-directory="));
  if (inline) return [inline.slice("--target-directory=".length)];
  const positional = args.filter((a) => !a.startsWith("-"));
  return positional.length >= 2 ? positional.slice(-1) : [];
}

/** Arguments that are only written to (so naming an env file there does not read secrets). */
function envWriteTargets(inv: Invocation): Set<string> {
  const { name, args } = inv;
  if (ENV_FILE_WRITERS.has(name)) return new Set(args);
  return new Set(COPY_VERBS.has(name) ? copyDestinations(args) : []);
}

function dumpsEnvironment(inv: Invocation): boolean {
  const { name, args } = inv;
  if (["get-childitem", "gci", "dir", "ls", "get-item", "gi"].includes(name)) {
    return args.some((a) => /^env:[\\/]?$/i.test(a) || (/^env:/i.test(a) && /[*?]/.test(a)));
  }
  if (name === "printenv") return true;
  // `env` reaching here has no command to run (`env -S` is a launcher).
  if (name === "env") return !args.some((a) => /^(?:-S|--split-string)/.test(a));
  if (name === "set") return args.length === 0;
  if (["export", "declare", "typeset"].includes(name)) return args.every((a) => a.startsWith("-"));
  return false;
}

function readsCredentials(inv: Invocation): boolean {
  const writeTargets = envWriteTargets(inv);
  return (
    scannableArgs(inv).some((a) => isCredentialPath(a) || (isSecretEnvFile(a) && !writeTargets.has(a))) ||
    inv.inputs.some((a) => isCredentialPath(a) || isSecretEnvFile(a)) ||
    inv.redirects.some(isCredentialPath)
  );
}

function shellTouchesCredentials(command: string, invocations: Invocation[]): boolean {
  if (/\[(?:system\.)?environment\]::getenvironmentvariables\b/i.test(command)) return true;
  return invocations.some((inv) => dumpsEnvironment(inv) || readsCredentials(inv));
}

// ---------------------------------------------------------------------------
// Rule: git-remote (including command-valued git settings)
// ---------------------------------------------------------------------------

const GIT_VALUE_OPTIONS = new Set(["-C", "--git-dir", "--work-tree", "--namespace"]);
/** Keys whose value git executes as a command. */
const GIT_COMMAND_KEY =
  /^(?:core\.(?:pager|editor|fsmonitor|askpass|sshcommand)|pager\..+|sequence\.editor|diff\.external|diff\..+\.(?:command|textconv)|merge\..+\.driver|filter\..+\.(?:clean|smudge|process)|gpg\.(?:.+\.)?program|uploadpack\.packobjectshook)$/;
const GIT_REMOTE_KEY = /^(?:remote\.|url\.|credential(?:\.|$))/;
const GIT_LOCATION_KEY = /^(?:core\.hookspath|include\.path|includeif\..+)$/;
/** Environment variables git treats like command-valued settings. */
const GIT_ENV_KEYS = new Map([
  ["GIT_SSH_COMMAND", "core.sshcommand"], ["GIT_SSH", "core.sshcommand"],
  ["GIT_PAGER", "core.pager"], ["PAGER", "core.pager"],
  ["GIT_EDITOR", "core.editor"], ["EDITOR", "core.editor"], ["VISUAL", "core.editor"],
  ["GIT_SEQUENCE_EDITOR", "sequence.editor"], ["GIT_EXTERNAL_DIFF", "diff.external"],
  ["GIT_ASKPASS", "core.askpass"], ["SSH_ASKPASS", "core.askpass"],
]);

interface GitSetting {
  key: string;
  value: string;
}

/** Position of the git sub-command after global options, plus the `-c` settings. */
function gitSubcommand(args: string[]): { sub: string; rest: string[]; configs: GitSetting[] } {
  const configs: GitSetting[] = [];
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    if (args[i] === "-c") {
      const entry = args[++i] ?? "";
      const index = entry.indexOf("=");
      configs.push(index < 0 ? { key: entry.toLowerCase(), value: "true" } : {
        key: entry.slice(0, index).toLowerCase(),
        value: entry.slice(index + 1),
      });
    } else if (GIT_VALUE_OPTIONS.has(args[i])) {
      i++;
    }
    i++;
  }
  return { sub: (args[i] ?? "").toLowerCase(), rest: args.slice(i + 1), configs };
}

/** Transient settings: `git -c`, git-related environment variables, `GIT_CONFIG_KEY_n` pairs. */
function transientGitSettings(invocations: Invocation[]): GitSetting[] {
  const settings: GitSetting[] = [];
  const keys = new Map<string, string>();
  const values = new Map<string, string>();
  for (const inv of invocations) {
    if (inv.name === "git") settings.push(...gitSubcommand(inv.args).configs);
    for (const [variable, value] of inv.assignments) {
      const upper = variable.toUpperCase();
      const key = GIT_ENV_KEYS.get(upper);
      if (key) settings.push({ key, value });
      const pair = /^GIT_CONFIG_(KEY|VALUE)_(\d+)$/.exec(upper);
      if (pair) (pair[1] === "KEY" ? keys : values).set(pair[2], value);
    }
  }
  for (const [index, key] of keys) settings.push({ key: key.toLowerCase(), value: values.get(index) ?? "" });
  return settings;
}

/** Commands git would run because of a setting. */
function gitSettingPayloads(setting: GitSetting): string[] {
  const value = setting.value.trim();
  if (setting.key.startsWith("alias.")) return [value.startsWith("!") ? value.slice(1) : `git ${value}`];
  if (!GIT_COMMAND_KEY.test(setting.key)) return [];
  if (setting.key === "core.fsmonitor" && /^(?:true|false|yes|no|on|off|1|0)?$/i.test(value)) return [];
  return [value.replace(/^!/, "")];
}

function transientSettingBlocked(setting: GitSetting, ctx: GuardContext): boolean {
  if (GIT_REMOTE_KEY.test(setting.key)) return true;
  return GIT_LOCATION_KEY.test(setting.key) && anyOutside([setting.value], ctx, atWorkspace(ctx));
}

/**
 * Persistent `git config` writes to keys that run commands or redirect remotes/credentials.
 * The per-task worktree shares the main repository's `.git/config`, so such writes would take
 * effect later, outside the guard (e.g. when the user or MDium runs git), regardless of value.
 */
function writesProtectedGitConfig(rest: string[]): boolean {
  const readOnly = rest.some((a) => /^(?:--get(?:-all|-regexp|-urlmatch)?|--list|-l|get|list)$/.test(a));
  if (readOnly) return false;
  return rest
    .filter((a) => !a.startsWith("-"))
    .map((a) => a.toLowerCase())
    .some((key) => GIT_COMMAND_KEY.test(key) || GIT_REMOTE_KEY.test(key) || GIT_LOCATION_KEY.test(key) || key.startsWith("alias."));
}

function changesGitRemote(inv: Invocation): boolean {
  if (inv.name !== "git") return false;
  const { sub, rest } = gitSubcommand(inv.args);
  if (sub === "push" || sub === "send-pack" || sub === "http-push" || sub.startsWith("credential")) return true;
  if (sub === "remote") {
    const action = rest.find((a) => !a.startsWith("-"))?.toLowerCase() ?? "";
    return ["add", "set-url", "rename", "remove", "rm"].includes(action);
  }
  return sub === "config" && writesProtectedGitConfig(rest);
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
const TOKEN_PARAM =
  /[?&#](?!(?:page|next)_token=|sort_key=)(?:[\w-]*[_-])?(?:token|key|apikey|secret|password|pw|auth|authorization|sig|signature)=/i;

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
  if (has("--dry-run")) return false;
  if (["npm", "pnpm", "yarn", "cargo"].includes(name)) return has("publish");
  if (["docker", "podman"].includes(name)) return has("push") || has("--push");
  if (name === "gem") return has("push");
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
  if (["chmod", "chown", "icacls"].includes(name)) return anyOutside(args, ctx, atWorkspace(ctx));
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
const DOTNET_IO_CALL = /\[(?:system\.)?io\.(?:file|directory)\]::(\w+)\s*\(([^)]{0,4096})\)/gi;
const DOTNET_WRITE_METHOD =
  /^(?:write|append|create|delete|move|copy|replace|open|setattributes|encrypt|decrypt)/i;

function changeDirTarget(inv: Invocation): string | undefined {
  return inv.args.find((a) => !a.startsWith("-") && !/^\/d$/i.test(a));
}

/** String literals passed to `[IO.File]::WriteAllText(...)` and similar static .NET writes. */
function dotnetWriteLiterals(command: string): string[] {
  const literals: string[] = [];
  for (const call of command.matchAll(DOTNET_IO_CALL)) {
    if (!DOTNET_WRITE_METHOD.test(call[1])) continue;
    literals.push(...[...call[2].matchAll(/"([^"]*)"|'([^']*)'/g)].map((l) => l[1] ?? l[2]));
  }
  return literals;
}

function dotnetWritesOutside(command: string, ctx: GuardContext): boolean {
  return anyOutside(dotnetWriteLiterals(command), ctx, atWorkspace(ctx));
}

/** Current directory tracked as segments so each `cd` costs only its own length. */
class TrackedDirectory {
  private root = "";
  private parts: string[] = [];
  private cached: string | null = null;
  /** Segment count of the writable root containing the directory, or -1 when outside. */
  floor = 0;

  constructor(
    private readonly ctx: GuardContext,
    private readonly lib: typeof path.win32,
  ) {
    this.setAbsolute(ctx.workspaceRoot);
  }

  toString(): string {
    this.cached ??= this.root + this.parts.join(this.lib.sep);
    return this.cached;
  }

  change(target: string): void {
    if (isAbsoluteToken(target, this.ctx.platform)) {
      this.setAbsolute(normalizePath(target, this.ctx));
      return;
    }
    for (const part of target.split(/[\\/]+/)) {
      if (!part || part === ".") continue;
      this.cached = null;
      if (part !== "..") {
        this.parts.push(part);
      } else {
        this.parts.pop();
        if (this.parts.length < this.floor) this.floor = this.writableFloor();
      }
    }
  }

  private setAbsolute(absolute: string): void {
    this.root = this.lib.parse(absolute).root;
    this.parts = absolute.slice(this.root.length).split(/[\\/]+/).filter(Boolean);
    this.cached = null;
    this.floor = this.writableFloor();
  }

  private writableFloor(): number {
    const current = this.toString();
    for (const root of writableRoots(this.ctx)) {
      if (!isInside(current, root, this.ctx.platform)) continue;
      const resolved = this.lib.resolve(root);
      return resolved.slice(this.lib.parse(resolved).root.length).split(/[\\/]+/).filter(Boolean).length;
    }
    return -1;
  }
}

/** Walk invocations in order, tracking `cd` so `..` escapes resolve against the current directory. */
function writesOutsideWorkspace(invocations: Invocation[], ctx: GuardContext): boolean {
  const cwd = new TrackedDirectory(ctx, pathLib(ctx.platform));
  const base = () => cwd.toString();
  for (const [index, inv] of invocations.entries()) {
    if (CHANGE_DIR.has(inv.name)) {
      const target = changeDirTarget(inv);
      if (!target || target === "-") continue;
      cwd.change(target);
      // Leaving the worktree and then running anything else is treated as a write risk.
      if (cwd.floor < 0 && index < invocations.length - 1) return true;
      continue;
    }
    if (anyOutside(inv.redirects, ctx, base)) return true;
    if (WRITE_VERBS.has(inv.name) && anyOutside(inv.args, ctx, base)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rule: agent-config
// ---------------------------------------------------------------------------

// Agent CLIs load these from the workspace on the next turn (hooks, permissions, MCP servers),
// outside the guard, and they would reach the user's repository through the task branch. Inside
// a worktree `.git` points at the shared repository, so its hooks and config are covered too.
const AGENT_CONFIG_DIRS = new Set([".claude", ".opencode", ".codex", ".copilot", ".git"]);
const AGENT_CONFIG_FILES = new Set(["opencode.json", "opencode.jsonc", ".mcp.json", ".gitmodules"]);
const VSCODE_AGENT_FILES = new Set(["settings.json", "tasks.json", "mcp.json"]);
const COPY_DESTINATION_VERBS = new Set(["cp", "copy", "copy-item", "cpi"]);

/** Lowercased path segments relative to the containing writable root (whole path when outside). */
function relativeSegments(absolute: string, ctx: GuardContext): string[] {
  const lib = pathLib(ctx.platform);
  const root = writableRoots(ctx).find((r) => isInside(absolute, r, ctx.platform));
  const relative = root ? lib.relative(lib.resolve(root), absolute) : absolute;
  return relative
    .split(/[\\/]+/)
    .filter(Boolean)
    // Windows ignores NTFS stream suffixes and trailing dots/spaces in names.
    .map((part) => part.toLowerCase().replace(/::\$data$/, "").replace(/[. ]+$/, ""));
}

function isAgentConfigPath(absolute: string, ctx: GuardContext): boolean {
  const parts = relativeSegments(absolute, ctx);
  const last = parts.length - 1;
  return parts.some(
    (part, i) =>
      AGENT_CONFIG_DIRS.has(part) ||
      (i === last && AGENT_CONFIG_FILES.has(part)) ||
      (part === ".vscode" && i === last - 1 && VSCODE_AGENT_FILES.has(parts[last])),
  );
}

/** Arguments a writing command writes to; copies only write their destination. */
function writtenArgs(inv: Invocation): string[] {
  if (COPY_DESTINATION_VERBS.has(inv.name)) return copyDestinations(inv.args);
  return WRITE_VERBS.has(inv.name) ? inv.args : [];
}

/** Path-like tokens (option prefixes removed, comma arrays split, options and devices dropped). */
function pathCandidates(tokens: string[]): string[] {
  return tokens
    .map((t) => (t.startsWith("-") ? t.replace(PARAM_PREFIX, "") : t))
    .flatMap((t) => t.split(","))
    .map(stripQuotes)
    .filter((t) => t && !t.startsWith("-") && !DEVICE_TARGETS.test(t));
}

/** Shell writes (write verbs, redirections, static .NET writes) into agent or git configuration. */
function writesAgentConfig(command: string, invocations: Invocation[], ctx: GuardContext): boolean {
  const cwd = new TrackedDirectory(ctx, pathLib(ctx.platform));
  const hits = (tokens: string[]) =>
    pathCandidates(tokens).some((t) => isAgentConfigPath(normalizePath(t, ctx, cwd.toString()), ctx));
  for (const inv of invocations) {
    if (CHANGE_DIR.has(inv.name)) {
      const target = changeDirTarget(inv);
      if (target && target !== "-") cwd.change(target);
    } else if (hits(inv.redirects) || hits(writtenArgs(inv))) {
      return true;
    }
  }
  return dotnetWriteLiterals(command).some((l) => isAgentConfigPath(normalizePath(l, ctx), ctx));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Parse a shell command, expanding commands that git settings would run. */
function inspectShell(command: string, dialect: Dialect): { invocations: Invocation[]; settings: GitSetting[]; overflow: boolean } {
  const state: ParseState = { budget: MAX_SEGMENTS, overflow: false };
  const invocations = parseCommand(command, dialect, state);
  const settings: GitSetting[] = [];
  let frontier = invocations;
  for (let level = 0; level < MAX_NESTING && frontier.length; level++) {
    const found = transientGitSettings(frontier);
    settings.push(...found);
    // git runs command-valued settings through sh.
    frontier = found.flatMap(gitSettingPayloads).flatMap((p) => parseCommand(p, "posix", state, 1));
    invocations.push(...frontier);
  }
  return { invocations, settings, overflow: state.overflow };
}

/**
 * Dialects to inspect a shell request with. On Windows an unknown shell may be PowerShell
 * or Git Bash, so both interpretations are checked and either one can block.
 */
function shellDialects(request: ToolRequest, ctx: GuardContext): Dialect[] {
  if (request.shell) return [request.shell];
  return ctx.platform === "win32" ? ["powershell", "posix"] : ["posix"];
}

function shellViolation(command: string, dialects: Dialect[], ctx: GuardContext): GuardRule | null {
  for (const dialect of dialects) {
    const rule = dialectViolation(command, dialect, ctx);
    if (rule) return rule;
  }
  return null;
}

function dialectViolation(command: string, dialect: Dialect, ctx: GuardContext): GuardRule | null {
  const { invocations, settings, overflow } = inspectShell(command, dialect);
  if (overflow) return "outside-workspace";
  if (shellTouchesCredentials(command, invocations)) return "credentials";
  if (writesAgentConfig(command, invocations, ctx)) return "agent-config";
  if (invocations.some(changesGitRemote) || settings.some((s) => transientSettingBlocked(s, ctx))) return "git-remote";
  if (invocations.some(usesForgeCli)) return "forge-cli";
  if (invocations.some(sendsOverNetwork)) return "network-send";
  if (/\[(?:system\.)?environment\]::setenvironmentvariable\b/i.test(command)) return "system-config";
  if (invocations.some((inv) => changesSystemConfig(inv, ctx))) return "system-config";
  if (dotnetWritesOutside(command, ctx) || writesOutsideWorkspace(invocations, ctx)) return "outside-workspace";
  return null;
}

function firstViolation(request: ToolRequest, ctx: GuardContext): GuardRule | null {
  const { kind, summary } = request;
  // The adapter could not describe what the tool does, so nothing can vouch for it.
  if (request.opaque) return "opaque-tool";
  // Oversized input cannot be inspected within a bounded time.
  if (summary.length > MAX_COMMAND_LENGTH) return "outside-workspace";
  if (kind === "shell") return shellViolation(summary, shellDialects(request, ctx), ctx);
  // Writing an env file does not expose secrets; reading one does.
  if (isCredentialPath(summary) || (kind !== "write" && isSecretEnvFile(summary))) return "credentials";
  if (kind === "write" && isAgentConfigPath(normalizePath(summary, ctx), ctx)) return "agent-config";
  if (kind === "write" && !isWritable(normalizePath(summary, ctx), ctx)) return "outside-workspace";
  if (kind === "network" && isTokenBearingUrl(summary)) return "network-send";
  return null;
}

/** Decide whether a tool request may run under the guard (spec 3.7). */
export function checkToolRequest(request: ToolRequest, ctx: GuardContext): GuardVerdict {
  const rule = firstViolation(request, ctx);
  return rule ? { ok: false, rule } : { ok: true };
}
