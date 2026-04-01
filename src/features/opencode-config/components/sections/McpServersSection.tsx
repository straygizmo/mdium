import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { useOpencodeConfigStore } from "@/stores/opencode-config-store";
import { useTabStore } from "@/stores/tab-store";
import type { OpencodeMcpServer } from "@/shared/types";
import { useOpencodeConfigContext, toRelativeProjectPath } from "../OpencodeConfigContext";
import { getOpencodeClient } from "../../hooks/useOpencodeChat";
import { resolveBuiltinCommand } from "../../lib/builtin-mcp-servers";
import {
  BUILTIN_MCP as REGISTRY_MCP,
  getMissingBuiltinMcp,
  isBuiltinMcp,
} from "../../lib/builtin-registry";
import { ScopeToggle, type Scope } from "../shared/ScopeToggle";
import { ScopeFormWrapper } from "../shared/ScopeFormWrapper";
import { useScopeItems } from "../../hooks/useScopeItems";

type McpType = "local" | "remote";

interface McpToolInfo {
  name: string;
  description: string;
}

interface McpTestResult {
  success: boolean;
  tools: McpToolInfo[];
  error: string | null;
}

const EMPTY_SERVERS: Record<string, OpencodeMcpServer> = {};

/** Normalize command to string[] (handles string, string[], and legacy command+args) */
function normalizeCommand(server: OpencodeMcpServer): string[] {
  const cmd = server.command;
  if (Array.isArray(cmd)) return cmd;
  if (typeof cmd === "string") {
    const args = Array.isArray(server.args) ? server.args : [];
    return [cmd, ...args];
  }
  return [];
}

/** Resolve {env:VARIABLE_NAME} patterns in a record's values via Tauri get_env_var */
async function resolveEnvPatterns(
  record: Record<string, string> | undefined
): Promise<Record<string, string> | undefined> {
  if (!record) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    resolved[key] = await resolveEnvValue(value);
  }
  return resolved;
}

async function resolveEnvValue(value: string): Promise<string> {
  const pattern = /\{env:([^}]+)\}/g;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    result += value.slice(lastIndex, match.index);
    try {
      const envVal = await invoke<string>("get_env_var", { name: match[1] });
      result += envVal;
    } catch {
      // env var not found – leave empty
      result += "";
    }
    lastIndex = pattern.lastIndex;
  }
  result += value.slice(lastIndex);
  return result;
}

/** Sync MCP server config to the running opencode serve instance via SDK */
async function syncMcpToServer(name: string, server: OpencodeMcpServer) {
  const client = getOpencodeClient();
  if (!client) return;

  try {
    if (server.enabled === false) {
      await client.mcp.disconnect({ path: { name } });
    } else {
      const config = server.type === "remote"
        ? {
            type: "remote" as const,
            url: server.url ?? "",
            enabled: server.enabled,
            headers: await resolveEnvPatterns(server.headers),
          }
        : {
            type: "local" as const,
            command: normalizeCommand(server),
            environment: await resolveEnvPatterns(server.environment),
            enabled: server.enabled,
          };
      await client.mcp.add({ body: { name, config } });
    }
  } catch (e) {
    console.warn("[mcp-sync] failed to sync:", e);
  }
}

async function removeMcpFromServer(name: string) {
  const client = getOpencodeClient();
  if (!client) return;

  try {
    await client.mcp.disconnect({ path: { name } });
  } catch (e) {
    console.warn("[mcp-sync] failed to disconnect:", e);
  }
}

export function McpServersSection() {
  const { t } = useTranslation("opencode-config");
  const config = useOpencodeConfigStore((s) => s.config);
  const projectMcpServers = useOpencodeConfigStore((s) => s.projectMcpServers);
  const saveMcpServer = useOpencodeConfigStore((s) => s.saveMcpServer);
  const deleteMcpServer = useOpencodeConfigStore((s) => s.deleteMcpServer);
  const loadConfig = useOpencodeConfigStore((s) => s.loadConfig);
  const loadProjectMcpServers = useOpencodeConfigStore((s) => s.loadProjectMcpServers);
  const saveProjectMcpServer = useOpencodeConfigStore((s) => s.saveProjectMcpServer);
  const deleteProjectMcpServer = useOpencodeConfigStore((s) => s.deleteProjectMcpServer);
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const { useRelativePaths } = useOpencodeConfigContext();

  const [formScope, setFormScope] = useState<Scope>("project");
  const [editingScope, setEditingScope] = useState<Scope | null>(null);
  const [globalConfigPath, setGlobalConfigPath] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [formName, setFormName] = useState("");
  const [formType, setFormType] = useState<McpType>("local");
  const [formEnabled, setFormEnabled] = useState(true);
  const [formCommand, setFormCommand] = useState("");
  const [formArgs, setFormArgs] = useState("");
  const [formEnv, setFormEnv] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formHeaders, setFormHeaders] = useState("");
  const [formTimeout, setFormTimeout] = useState("10000");
  const [jsonImportOpen, setJsonImportOpen] = useState(false);
  const [jsonInput, setJsonInput] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [mcpServersPath, setMcpServersPath] = useState("");

  // Test state: keyed by server name
  const [testingServer, setTestingServer] = useState<string | null>(null);
  const [serverTools, setServerTools] = useState<Record<string, McpToolInfo[]>>({});
  const [testErrors, setTestErrors] = useState<Record<string, string>>({});
  const [toolsDialogServer, setToolsDialogServer] = useState<string | null>(null);
  const [showBuiltinMenu, setShowBuiltinMenu] = useState(false);

  useEffect(() => {
    invoke<string>("get_home_dir").then((home) => {
      const sep = home.includes("\\") ? "\\" : "/";
      setGlobalConfigPath(`${home}${sep}.config${sep}opencode${sep}opencode.jsonc`);
    });
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  useEffect(() => {
    if (activeFolderPath) loadProjectMcpServers(activeFolderPath);
  }, [activeFolderPath, loadProjectMcpServers]);

  useEffect(() => {
    invoke<string>("resolve_mcp_servers_path").then(setMcpServersPath).catch(() => {});
  }, []);

  const globalEntries = useMemo(
    () => Object.entries(config.mcp ?? {}).map(([name, server]) => ({ name, server })),
    [config.mcp]
  );
  const projectEntries = useMemo(
    () => Object.entries(projectMcpServers).map(([name, server]) => ({ name, server })),
    [projectMcpServers]
  );
  const scopedEntries = useScopeItems(globalEntries, projectEntries);

  const allServers = formScope === "global"
    ? (config.mcp ?? EMPTY_SERVERS)
    : projectMcpServers;
  const missingBuiltins = getMissingBuiltinMcp(allServers);

  const handleAddBuiltin = async (name: string) => {
    const entry = REGISTRY_MCP[name];
    if (!entry) return;
    const resolved = { ...entry };
    if (Array.isArray(resolved.command) && mcpServersPath) {
      resolved.command = resolveBuiltinCommand(resolved.command, mcpServersPath);
    }
    setFormScope("global");
    await saveMcpServer(name, resolved);
    setShowBuiltinMenu(false);
  };

  const startEdit = (name: string, server: OpencodeMcpServer, itemScope: Scope) => {
    const serverType = server.type ?? "local";
    setEditing(name);
    setEditingScope(itemScope);
    setFormScope(itemScope);
    setFormName(name);
    setFormType(serverType);
    setFormEnabled(server.enabled !== false);
    const cmdArr = normalizeCommand(server);
    setFormCommand(cmdArr[0] ?? "");
    setFormArgs(cmdArr.slice(1).join(" "));
    setFormEnv(
      server.environment
        ? Object.entries(server.environment).map(([k, v]) => `${k}=${v}`).join("\n")
        : ""
    );
    setFormUrl(server.url ?? "");
    setFormHeaders(
      server.headers
        ? Object.entries(server.headers).map(([k, v]) => `${k}: ${v}`).join("\n")
        : ""
    );
    setFormTimeout(String(server.timeout ?? 10000));
  };

  const startAdd = () => {
    setAdding(true);
    setFormScope("project");
    setEditingScope(null);
    setFormName("");
    setFormType("local");
    setFormEnabled(true);
    setFormCommand("");
    setFormArgs("");
    setFormEnv("");
    setFormUrl("");
    setFormHeaders("");
    setFormTimeout("10000");
    setJsonImportOpen(false);
    setJsonInput("");
    setJsonError("");
  };

  const applyJsonImport = () => {
    setJsonError("");
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonInput);
    } catch {
      setJsonError(t("mcpJsonErrorInvalid"));
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setJsonError(t("mcpJsonErrorNotObject"));
      return;
    }

    let obj = parsed as Record<string, unknown>;

    // Unwrap config envelope: { "mcp": { ... } } or { "mcpServers": { ... } }
    for (const envelope of ["mcp", "mcpServers"] as const) {
      if (envelope in obj && typeof obj[envelope] === "object" && obj[envelope] !== null && !Array.isArray(obj[envelope])) {
        obj = obj[envelope] as Record<string, unknown>;
        break;
      }
    }

    // Determine format A vs B
    let serverConfig: Record<string, unknown>;
    if ("type" in obj || "command" in obj || "url" in obj) {
      // Format B: direct server config
      serverConfig = obj;
    } else {
      // Format A: { "server-name": { ...config } }
      const keys = Object.keys(obj);
      if (keys.length === 0) {
        setJsonError(t("mcpJsonErrorNotObject"));
        return;
      }
      const serverName = keys[0];
      const inner = obj[serverName];
      if (typeof inner !== "object" || inner === null || Array.isArray(inner)) {
        setJsonError(t("mcpJsonErrorNotObject"));
        return;
      }
      setFormName(serverName);
      serverConfig = inner as Record<string, unknown>;
    }

    // Apply type (stdio → local)
    const serverType = serverConfig.type === "remote" ? "remote" : "local";
    setFormType(serverType);

    // Apply enabled
    setFormEnabled(serverConfig.enabled !== false);

    // Apply command + args (handle both Claude format and opencode format)
    if (serverType === "local") {
      const cmd = serverConfig.command;
      const args = serverConfig.args;
      if (Array.isArray(cmd)) {
        // opencode format: command is array ["uvx", "arg1", "arg2"]
        setFormCommand(String(cmd[0] ?? ""));
        const restArgs = cmd.slice(1).map(String);
        setFormArgs(restArgs.join(" "));
      } else if (typeof cmd === "string") {
        // Claude format: command is string, args is separate array
        setFormCommand(cmd);
        if (Array.isArray(args)) {
          setFormArgs(args.map(String).join(" "));
        }
      }
    }

    // Apply env / environment
    const envObj = (serverConfig.env ?? serverConfig.environment) as Record<string, string> | undefined;
    if (envObj && typeof envObj === "object") {
      setFormEnv(Object.entries(envObj).map(([k, v]) => `${k}=${v}`).join("\n"));
    }

    // Apply url
    if (typeof serverConfig.url === "string") {
      setFormUrl(serverConfig.url);
    }

    // Apply headers
    const hdrs = serverConfig.headers as Record<string, string> | undefined;
    if (hdrs && typeof hdrs === "object") {
      setFormHeaders(Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`).join("\n"));
    }

    // Apply timeout
    if (typeof serverConfig.timeout === "number") {
      setFormTimeout(String(serverConfig.timeout));
    }

    setJsonImportOpen(false);
    setJsonInput("");
  };

  const handleSave = async () => {
    const name = formName.trim();
    if (!name) return;

    const serverObj: OpencodeMcpServer = {
      type: formType,
      enabled: formEnabled,
    };

    if (formType === "local") {
      if (!formCommand.trim()) return;
      const cmdParts = [formCommand.trim()];
      const args = formArgs.trim().split(/\s+/).filter(Boolean);
      if (args.length) cmdParts.push(...args);
      serverObj.command = cmdParts;
      const envLines = formEnv.trim().split("\n").filter(Boolean);
      if (envLines.length) {
        serverObj.environment = {};
        for (const line of envLines) {
          const idx = line.indexOf("=");
          if (idx > 0) {
            serverObj.environment[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
          }
        }
      }
    } else {
      if (!formUrl.trim()) return;
      serverObj.url = formUrl.trim();
      const headerLines = formHeaders.trim().split("\n").filter(Boolean);
      if (headerLines.length) {
        serverObj.headers = {};
        for (const line of headerLines) {
          const idx = line.indexOf(":");
          if (idx > 0) {
            serverObj.headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
          }
        }
      }
    }

    const timeoutVal = parseInt(formTimeout, 10);
    if (!isNaN(timeoutVal) && timeoutVal > 0) {
      serverObj.timeout = timeoutVal;
    }

    // If scope changed during edit, delete from old scope
    if (editing && editingScope && editingScope !== formScope) {
      if (editingScope === "global") {
        await deleteMcpServer(editing);
      } else {
        await deleteProjectMcpServer(activeFolderPath!, editing);
      }
    }

    // Save to target scope
    if (formScope === "global") {
      await saveMcpServer(name, serverObj);
    } else {
      await saveProjectMcpServer(activeFolderPath!, name, serverObj);
    }

    // Sync to running opencode serve instance
    await syncMcpToServer(name, serverObj);

    // Reload both
    await loadConfig();
    if (activeFolderPath) await loadProjectMcpServers(activeFolderPath);

    setEditing(null);
    setAdding(false);
  };

  const handleDelete = async (name: string, itemScope: Scope) => {
    const confirmed = await ask(t("mcpDeleteConfirm", { name }), { kind: "warning" });
    if (!confirmed) return;
    if (itemScope === "global") {
      await deleteMcpServer(name);
    } else if (activeFolderPath) {
      await deleteProjectMcpServer(activeFolderPath, name);
    }
    // Disconnect from running opencode serve instance
    await removeMcpFromServer(name);
    // Clean up test state
    setServerTools((prev) => { const next = { ...prev }; delete next[name]; return next; });
    setTestErrors((prev) => { const next = { ...prev }; delete next[name]; return next; });
  };

  const handleCancel = () => {
    setEditing(null);
    setAdding(false);
    setEditingScope(null);
  };

  const handleTest = async (name: string, server: OpencodeMcpServer) => {
    setTestingServer(name);
    setTestErrors((prev) => { const next = { ...prev }; delete next[name]; return next; });

    try {
      const serverType = server.type ?? "local";
      const cmdArr = normalizeCommand(server);
      const result = await invoke<McpTestResult>("mcp_test_server", {
        serverType,
        command: cmdArr[0] ?? null,
        args: cmdArr.length > 1 ? cmdArr.slice(1) : null,
        env: server.environment ?? null,
        url: server.url ?? null,
        headers: server.headers ?? null,
      });

      if (result.success) {
        setServerTools((prev) => ({ ...prev, [name]: result.tools }));
        setTestErrors((prev) => { const next = { ...prev }; delete next[name]; return next; });
      } else {
        setServerTools((prev) => { const next = { ...prev }; delete next[name]; return next; });
        setTestErrors((prev) => ({ ...prev, [name]: result.error ?? t("mcpTestFailed") }));
      }
    } catch (e) {
      setServerTools((prev) => { const next = { ...prev }; delete next[name]; return next; });
      setTestErrors((prev) => ({ ...prev, [name]: String(e) }));
    } finally {
      setTestingServer(null);
    }
  };

  const openToolsDialog = (name: string) => {
    setToolsDialogServer(name);
  };

  const isEditing = adding || editing !== null;

  const displayPath = formScope === "global"
    ? globalConfigPath
    : activeFolderPath
      ? `${activeFolderPath}${activeFolderPath.includes("\\") ? "\\" : "/"}opencode.jsonc`
      : "";

  const getServerDetail = (server: OpencodeMcpServer) => {
    const serverType = server.type ?? "local";
    if (serverType === "remote") {
      return server.url ?? "";
    }
    return normalizeCommand(server).join(" ");
  };

  return (
    <div>
      <div className="oc-section__hint">
        {t("mcpDescription")}
        {" "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            invoke("open_external_url", { url: t("mcpDocsUrl") });
          }}
          style={{ textDecoration: "none", cursor: "pointer" }}
          title={t("mcpDocsUrl")}
        >
          🔗
        </a>
      </div>

      {isEditing ? (
        <>
          <ScopeToggle value={formScope} onChange={setFormScope} />

          <ScopeFormWrapper scope={formScope}>
            {/* JSON Import */}
            <button
              className="oc-section__json-toggle"
              type="button"
              onClick={() => { setJsonImportOpen((v) => !v); setJsonError(""); }}
            >
              {jsonImportOpen ? "▼" : "▶"} {t("mcpJsonImport")}
            </button>
            {jsonImportOpen && (
              <div className="oc-section__json-area">
                <textarea
                  className="oc-section__textarea"
                  value={jsonInput}
                  onChange={(e) => setJsonInput(e.target.value)}
                  placeholder={t("mcpJsonPlaceholder")}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    className="oc-section__json-apply-btn"
                    type="button"
                    onClick={applyJsonImport}
                  >
                    {t("mcpJsonApply")}
                  </button>
                  {jsonError && <span className="oc-section__json-error">{jsonError}</span>}
                </div>
              </div>
            )}

            <div className="oc-section__field">
              <label className="oc-section__label">{t("mcpName")}</label>
              <input className="oc-section__input" value={formName} onChange={(e) => setFormName(e.target.value)} disabled={editing !== null} />
            </div>

            {/* Type selector: local / remote */}
            <div className="oc-section__field">
              <label className="oc-section__label">{t("mcpType")}</label>
              <div className="oc-section__type-tabs">
                <button
                  className={`oc-section__type-tab${formType === "local" ? " oc-section__type-tab--active" : ""}`}
                  onClick={() => setFormType("local")}
                  type="button"
                >
                  {t("mcpTypeLocal")}
                </button>
                <button
                  className={`oc-section__type-tab${formType === "remote" ? " oc-section__type-tab--active" : ""}`}
                  onClick={() => setFormType("remote")}
                  type="button"
                >
                  {t("mcpTypeRemote")}
                </button>
              </div>
            </div>

            {formType === "local" ? (
              <>
                <div className="oc-section__field">
                  <label className="oc-section__label">{t("mcpCommand")}</label>
                  <input className="oc-section__input" value={formCommand} onChange={(e) => setFormCommand(e.target.value)} placeholder="npx" />
                </div>
                <div className="oc-section__field">
                  <label className="oc-section__label">{t("mcpArgs")}</label>
                  <input className="oc-section__input" value={formArgs} onChange={(e) => setFormArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-github" />
                </div>
                <div className="oc-section__field">
                  <label className="oc-section__label">{t("mcpEnv")}</label>
                  <textarea className="oc-section__textarea" value={formEnv} onChange={(e) => setFormEnv(e.target.value)} placeholder="KEY=value" />
                </div>
                <div className="oc-section__field">
                  <label className="oc-section__label">{t("mcpTimeout")}</label>
                  <input className="oc-section__input" type="number" min="1000" step="1000" value={formTimeout} onChange={(e) => setFormTimeout(e.target.value)} placeholder="10000" />
                </div>
              </>
            ) : (
              <>
                <div className="oc-section__field">
                  <label className="oc-section__label">{t("mcpUrl")}</label>
                  <input className="oc-section__input" value={formUrl} onChange={(e) => setFormUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
                </div>
                <div className="oc-section__field">
                  <label className="oc-section__label">{t("mcpHeaders")}</label>
                  <textarea className="oc-section__textarea" value={formHeaders} onChange={(e) => setFormHeaders(e.target.value)} placeholder="Authorization: Bearer TOKEN" />
                </div>
                <div className="oc-section__field">
                  <label className="oc-section__label">{t("mcpTimeout")}</label>
                  <input className="oc-section__input" type="number" min="1000" step="1000" value={formTimeout} onChange={(e) => setFormTimeout(e.target.value)} placeholder="10000" />
                </div>
              </>
            )}

            {/* Enabled toggle */}
            <label className="oc-section__toggle oc-section__toggle--inline">
              <span>{t("mcpEnabled")}</span>
              <input type="checkbox" checked={formEnabled} onChange={(e) => setFormEnabled(e.target.checked)} />
            </label>
          </ScopeFormWrapper>

          {displayPath && (
            <div className="oc-section__path-hint">
              {t("mcpSavePath")}:{" "}
              {useRelativePaths && formScope === "project" && activeFolderPath
                ? toRelativeProjectPath(activeFolderPath, displayPath)
                : displayPath}
            </div>
          )}
          <div className="oc-section__form-actions" style={{ marginTop: 8 }}>
            <button className="oc-section__save-btn" onClick={handleSave}>{t("save")}</button>
            <button className="oc-section__cancel-btn" onClick={handleCancel}>{t("cancel")}</button>
          </div>
        </>
      ) : (
        <>
          {scopedEntries.length === 0 && <div className="oc-section__empty">{t("mcpEmpty")}</div>}
          {scopedEntries.map(({ scope: itemScope, data: { name, server } }) => {
            const serverType = server.type ?? "local";
            const isEnabled = server.enabled !== false;
            const isTesting = testingServer === name;
            const tools = serverTools[name];
            const testError = testErrors[name];
            return (
              <div key={`${itemScope}-${name}`} className={`oc-section__item oc-section__item--${itemScope}${!isEnabled ? " oc-section__item--disabled" : ""}`} style={{ marginBottom: 4 }}>
                <div className="oc-section__item-info">
                  <span className="oc-section__item-name">
                    {name}
                    {isBuiltinMcp(name) && (
                      <span className="oc-section__builtin-badge">Built-in</span>
                    )}
                    <span className={`oc-section__item-badge${serverType === "remote" ? " oc-section__item-badge--remote" : ""}`}>
                      {serverType}
                    </span>
                    {tools && tools.length > 0 && (
                      <span
                        className="oc-section__tools-badge"
                        onClick={() => openToolsDialog(name)}
                        title={t("mcpTools", { count: tools.length })}
                      >
                        {t("mcpTools", { count: tools.length })}
                      </span>
                    )}
                  </span>
                  <span className="oc-section__item-detail">{getServerDetail(server)}</span>
                  {testError && (
                    <span className="oc-section__test-status oc-section__test-status--error">{testError}</span>
                  )}
                </div>
                <div className="oc-section__item-actions">
                  <button
                    className="oc-section__test-btn"
                    onClick={() => handleTest(name, server)}
                    disabled={isTesting}
                  >
                    {isTesting ? t("mcpTesting") : t("mcpTest")}
                  </button>
                  <label className="oc-section__toggle" style={{ padding: 0 }}>
                    <input
                      type="checkbox"
                      checked={isEnabled}
                      onChange={async (e) => {
                        const updated = { ...server, enabled: e.target.checked };
                        if (itemScope === "global") {
                          await saveMcpServer(name, updated);
                        } else if (activeFolderPath) {
                          await saveProjectMcpServer(activeFolderPath, name, updated);
                        }
                        // Sync toggle to running opencode serve instance
                        await syncMcpToServer(name, updated);
                      }}
                    />
                  </label>
                  <button className="oc-section__edit-btn" onClick={() => startEdit(name, server, itemScope)}>{t("edit")}</button>
                  <button className="oc-section__delete-btn" onClick={() => handleDelete(name, itemScope)}>×</button>
                </div>
              </div>
            );
          })}
          <div style={{ display: "flex", alignItems: "center", marginTop: 4, position: "relative" }}>
            <button className="oc-section__add-btn" onClick={startAdd}>+ {t("add")}</button>
            {missingBuiltins.length > 0 && (
              <>
                <button
                  className="oc-section__builtin-btn"
                  onClick={() => setShowBuiltinMenu((v) => !v)}
                >
                  + Built-in
                </button>
                {showBuiltinMenu && (
                  <div className="oc-section__builtin-dropdown">
                    {missingBuiltins.map((name) => (
                      <button
                        key={name}
                        className="oc-section__builtin-dropdown-item"
                        onClick={() => handleAddBuiltin(name)}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {/* Tools list dialog */}
      {toolsDialogServer && serverTools[toolsDialogServer] && (
        <div className="oc-tools-dialog-overlay" onClick={() => setToolsDialogServer(null)}>
          <div className="oc-tools-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="oc-tools-dialog__header">
              <h3 className="oc-tools-dialog__title">
                {toolsDialogServer} — {t("mcpTools", { count: serverTools[toolsDialogServer].length })}
              </h3>
              <button className="oc-tools-dialog__close" onClick={() => setToolsDialogServer(null)}>×</button>
            </div>
            <div className="oc-tools-dialog__body">
              {serverTools[toolsDialogServer].map((tool) => (
                <div key={tool.name} className="oc-tools-dialog__item">
                  <span className="oc-tools-dialog__item-name">{tool.name}</span>
                  {tool.description && (
                    <span className="oc-tools-dialog__item-desc">{tool.description}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
