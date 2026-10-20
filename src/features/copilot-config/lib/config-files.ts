import type { CopilotMcpServer } from "@/shared/types";

/*
 * Copilot CLI configuration files edited by the settings panel:
 * - mcp-config.json / .github/mcp.json: `{ "mcpServers": { "<name>": { type, command, args, env, url, headers, tools, timeout } } }`
 * - settings.json: `disabledMcpServers` / `disabledSkills` string lists (the CLI's `mcp disable` / `skill disable`).
 * Unknown keys are preserved so files written by the CLI keep working.
 */

type JsonObject = Record<string, unknown>;

function parseObject(raw: string): JsonObject {
  try {
    const json: unknown = JSON.parse(raw);
    return typeof json === "object" && json !== null && !Array.isArray(json) ? (json as JsonObject) : {};
  } catch {
    return {};
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as JsonObject).filter(([, v]) => typeof v === "string")) as Record<string, string>;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

function serialize(json: JsonObject): string {
  return JSON.stringify(json, null, 2) + "\n";
}

/** Servers in an MCP config file; `disabled` marks the ones listed in settings.json. */
export function parseMcpServers(raw: string, disabled: readonly string[] = []): CopilotMcpServer[] {
  const servers = parseObject(raw).mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return [];
  return Object.entries(servers as JsonObject)
    .filter((entry): entry is [string, JsonObject] => typeof entry[1] === "object" && entry[1] !== null)
    .map(([name, s]) => {
      const rawType = typeof s.type === "string" ? s.type : "local";
      const type: CopilotMcpServer["type"] = rawType === "http" || rawType === "sse" ? rawType : "local";
      return {
        name,
        type,
        ...(typeof s.command === "string" ? { command: s.command } : {}),
        args: stringList(s.args) ?? [],
        env: stringRecord(s.env),
        ...(typeof s.url === "string" ? { url: s.url } : {}),
        headers: stringRecord(s.headers),
        ...(stringList(s.tools) ? { tools: stringList(s.tools) } : {}),
        ...(typeof s.timeout === "number" ? { timeout: s.timeout } : {}),
        enabled: !disabled.includes(name),
      };
    });
}

/** Add or replace a server entry, keeping keys this panel does not manage. */
export function upsertMcpServer(raw: string, server: CopilotMcpServer): string {
  const json = parseObject(raw);
  const servers = (typeof json.mcpServers === "object" && json.mcpServers !== null && !Array.isArray(json.mcpServers))
    ? { ...(json.mcpServers as JsonObject) }
    : {};
  const existing = typeof servers[server.name] === "object" && servers[server.name] !== null ? { ...(servers[server.name] as JsonObject) } : {};
  const remote = server.type !== "local";
  for (const key of remote ? ["command", "args", "env"] : ["url", "headers"]) delete existing[key];
  const entry: JsonObject = {
    ...existing,
    tools: server.tools ?? (stringList(existing.tools) ?? ["*"]),
    type: server.type,
  };
  if (server.timeout !== undefined) entry.timeout = server.timeout;
  else delete entry.timeout;
  if (remote) {
    entry.url = server.url ?? "";
    if (Object.keys(server.headers).length > 0) entry.headers = server.headers;
  } else {
    entry.command = server.command ?? "";
    if (server.args.length > 0) entry.args = server.args;
    else delete entry.args;
    if (Object.keys(server.env).length > 0) entry.env = server.env;
    else delete entry.env;
  }
  servers[server.name] = entry;
  return serialize({ ...json, mcpServers: servers });
}

export function removeMcpServer(raw: string, name: string): string {
  const json = parseObject(raw);
  if (typeof json.mcpServers !== "object" || json.mcpServers === null) return serialize(json);
  const servers = { ...(json.mcpServers as JsonObject) };
  delete servers[name];
  return serialize({ ...json, mcpServers: servers });
}

/** Names in a settings.json string list such as `disabledMcpServers` or `disabledSkills`. */
export function readSettingsList(raw: string, key: string): string[] {
  return stringList(parseObject(raw)[key]) ?? [];
}

/** settings.json with `name` added to or removed from the string list under `key`. */
export function setSettingsListEntry(raw: string, key: string, name: string, present: boolean): string {
  const json = parseObject(raw);
  const list = (stringList(json[key]) ?? []).filter((n) => n !== name);
  if (present) list.push(name);
  const next = { ...json };
  if (list.length > 0) next[key] = list;
  else delete next[key];
  return serialize(next);
}
