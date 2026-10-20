import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useCodexConfigStore } from "@/stores/codex-config-store";
import { showConfirm } from "@/stores/dialog-store";
import type { CodexMcpServer } from "@/shared/types";
import { SectionHint } from "@/features/claude-config/components/shared/SectionHint";
import type { Scope } from "@/features/claude-config/components/shared/ScopeToggle";
import { useHomeDir } from "@/features/claude-config/hooks/useHomeDir";
import { joinPath, toRelativeProjectPath } from "@/features/claude-config/lib/config-paths";
import { McpServerForm } from "./McpServerForm";

interface ScopedServer {
  scope: Scope;
  server: CodexMcpServer;
}

function serverDetail(server: CodexMcpServer): string {
  if (server.url) return server.url;
  return [server.command ?? "", ...server.args].join(" ").trim();
}

interface McpServersTabProps {
  folder: string;
}

export function McpServersTab({ folder }: McpServersTabProps) {
  const { t } = useTranslation("codex-config");
  const home = useHomeDir();
  const globalMcpServers = useCodexConfigStore((s) => s.globalMcpServers);
  const projectMcpServers = useCodexConfigStore((s) => s.projectMcpServers);
  const loadGlobalMcp = useCodexConfigStore((s) => s.loadGlobalMcp);
  const loadProjectMcp = useCodexConfigStore((s) => s.loadProjectMcp);
  const saveMcpServer = useCodexConfigStore((s) => s.saveMcpServer);
  const deleteMcpServer = useCodexConfigStore((s) => s.deleteMcpServer);
  const setMcpServerEnabled = useCodexConfigStore((s) => s.setMcpServerEnabled);

  const [editing, setEditing] = useState<ScopedServer | null>(null);
  const [adding, setAdding] = useState(false);
  const [formScope, setFormScope] = useState<Scope>("global");

  useEffect(() => {
    void loadGlobalMcp().catch(() => {});
    void loadProjectMcp(folder).catch(() => {});
  }, [loadGlobalMcp, loadProjectMcp, folder]);

  const items = useMemo<ScopedServer[]>(
    () => [
      ...globalMcpServers.map((server) => ({ scope: "global" as const, server })),
      ...projectMcpServers.map((server) => ({ scope: "project" as const, server })),
    ],
    [globalMcpServers, projectMcpServers],
  );

  const savePath = formScope === "global"
    ? (home ? joinPath(home, ".codex", "config.toml") : "")
    : toRelativeProjectPath(folder, joinPath(folder, ".codex", "config.toml"));

  const closeForm = () => {
    setAdding(false);
    setEditing(null);
  };

  const handleSave = async (server: CodexMcpServer) => {
    try {
      await saveMcpServer(formScope, folder, server);
    } catch {
      return; // store already reported the error
    }
    closeForm();
  };

  const handleDelete = async (scope: Scope, name: string) => {
    if (!(await showConfirm(t("mcpDeleteConfirm", { name }), { kind: "warning" }))) return;
    try {
      await deleteMcpServer(scope, folder, name);
    } catch {
      // store already reported the error
    }
  };

  const handleToggle = async (scope: Scope, server: CodexMcpServer) => {
    try {
      await setMcpServerEnabled(scope, folder, server.name, !server.enabled);
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
        initial={editing?.server}
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
        {items.map(({ scope, server }) => (
          <div
            key={`${scope}-${server.name}`}
            className={`claude-section__item claude-section__item--${scope}${server.enabled ? "" : " claude-section__item--disabled"}`}
          >
            <div className="claude-section__item-info">
              <span className="claude-section__item-name">
                {server.name}
                <span className={`claude-section__item-badge${server.url ? " claude-section__item-badge--remote" : ""}`}>
                  {server.url ? t("mcpTypeRemote") : t("mcpTypeLocal")}
                </span>
              </span>
              <span className="claude-section__item-detail">{serverDetail(server)}</span>
            </div>
            <div className="claude-section__item-actions">
              <label className="claude-section__toggle claude-section__toggle--compact">
                <input
                  type="checkbox"
                  data-switch
                  role="switch"
                  aria-label={t("mcpEnabled")}
                  checked={server.enabled}
                  onChange={() => void handleToggle(scope, server)}
                />
              </label>
              <button
                className="claude-section__edit-btn"
                onClick={() => { setFormScope(scope); setEditing({ scope, server }); }}
              >
                {t("edit")}
              </button>
              <button className="claude-section__delete-btn" onClick={() => void handleDelete(scope, server.name)}>
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
