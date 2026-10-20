import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useClaudeConfigStore } from "@/stores/claude-config-store";
import { useTabStore } from "@/stores/tab-store";
import { showConfirm } from "@/stores/dialog-store";
import type { McpServer } from "@/shared/types";
import { McpServerForm } from "./McpServerForm";
import { SectionHint } from "./shared/SectionHint";
import type { Scope } from "./shared/ScopeToggle";
import { useHomeDir } from "../hooks/useHomeDir";
import { joinPath, toRelativeProjectPath } from "../lib/config-paths";

interface ScopedServer {
  scope: Scope;
  name: string;
  server: McpServer;
}

export function McpServersTab() {
  const { t } = useTranslation("claude-config");
  const folder = useTabStore((s) => s.activeFolderPath)!;
  const home = useHomeDir();
  const globalMcpServers = useClaudeConfigStore((s) => s.globalMcpServers);
  const projectMcpServers = useClaudeConfigStore((s) => s.projectMcpServers);
  const loadGlobalMcp = useClaudeConfigStore((s) => s.loadGlobalMcp);
  const loadProjectMcp = useClaudeConfigStore((s) => s.loadProjectMcp);
  const saveGlobalMcpServer = useClaudeConfigStore((s) => s.saveGlobalMcpServer);
  const saveProjectMcpServer = useClaudeConfigStore((s) => s.saveProjectMcpServer);
  const deleteGlobalMcpServer = useClaudeConfigStore((s) => s.deleteGlobalMcpServer);
  const deleteProjectMcpServer = useClaudeConfigStore((s) => s.deleteProjectMcpServer);
  const toggleGlobalMcpServer = useClaudeConfigStore((s) => s.toggleGlobalMcpServer);
  const toggleProjectMcpServer = useClaudeConfigStore((s) => s.toggleProjectMcpServer);

  const [editing, setEditing] = useState<ScopedServer | null>(null);
  const [adding, setAdding] = useState(false);
  const [formScope, setFormScope] = useState<Scope>("global");

  useEffect(() => {
    void loadGlobalMcp();
    void loadProjectMcp(folder);
  }, [loadGlobalMcp, loadProjectMcp, folder]);

  const items = useMemo<ScopedServer[]>(
    () => [
      ...Object.entries(globalMcpServers).map(([name, server]) => ({ scope: "global" as const, name, server })),
      ...Object.entries(projectMcpServers).map(([name, server]) => ({ scope: "project" as const, name, server })),
    ],
    [globalMcpServers, projectMcpServers],
  );

  const savePath = formScope === "global"
    ? (home ? joinPath(home, ".claude.json") : "")
    : toRelativeProjectPath(folder, joinPath(folder, ".mcp.json"));

  const closeForm = () => {
    setAdding(false);
    setEditing(null);
  };

  const handleSave = async (name: string, server: McpServer) => {
    try {
      if (formScope === "global") await saveGlobalMcpServer(name, server);
      else await saveProjectMcpServer(folder, name, server);
    } catch {
      return; // store already reported the error
    }
    closeForm();
  };

  const handleDelete = async (scope: Scope, name: string) => {
    if (!(await showConfirm(t("mcpDeleteConfirm", { name }), { kind: "warning" }))) return;
    try {
      if (scope === "global") await deleteGlobalMcpServer(name);
      else await deleteProjectMcpServer(folder, name);
    } catch {
      // store already reported the error
    }
  };

  const handleToggle = async (scope: Scope, name: string) => {
    try {
      if (scope === "global") await toggleGlobalMcpServer(name);
      else await toggleProjectMcpServer(folder, name);
    } catch {
      // store already reported the error
    }
  };

  if (adding || editing !== null) {
    return (
      <McpServerForm
        scope={formScope}
        onScopeChange={setFormScope}
        scopeLocked={editing !== null}
        savePath={savePath}
        initialName={editing?.name}
        initialServer={editing?.server}
        onSave={handleSave}
        onCancel={closeForm}
      />
    );
  }

  return (
    <div className="claude-section">
      <SectionHint docsUrl={t("mcpDocsUrl")}>{t("mcpDescription")}</SectionHint>

      <div className="claude-section__list">
        {items.length === 0 && <div className="claude-section__empty">{t("mcpEmpty")}</div>}
        {items.map(({ scope, name, server }) => (
          <div
            key={`${scope}-${name}`}
            className={`claude-section__item claude-section__item--${scope}${server.disabled ? " claude-section__item--disabled" : ""}`}
          >
            <div className="claude-section__item-info">
              <span className="claude-section__item-name">{name}</span>
              <span className="claude-section__item-detail">
                {[server.command, ...(server.args ?? [])].join(" ")}
              </span>
            </div>
            <div className="claude-section__item-actions">
              <label className="claude-section__toggle claude-section__toggle--compact">
                <input
                  type="checkbox"
                  data-switch
                  role="switch"
                  aria-label={t("mcpEnabled")}
                  checked={!server.disabled}
                  onChange={() => void handleToggle(scope, name)}
                />
              </label>
              <button
                className="claude-section__edit-btn"
                onClick={() => { setFormScope(scope); setEditing({ scope, name, server }); }}
              >
                {t("edit")}
              </button>
              <button className="claude-section__delete-btn" onClick={() => void handleDelete(scope, name)}>
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="claude-section__list-actions">
        <button className="claude-section__add-btn" onClick={() => { setFormScope("global"); setAdding(true); }}>
          + {t("add")}
        </button>
      </div>
    </div>
  );
}
