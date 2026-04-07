import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useClaudeConfigStore } from "@/stores/claude-config-store";
import { showConfirm } from "@/stores/dialog-store";
import type { McpServer } from "@/shared/types";
import { McpServerForm } from "./McpServerForm";
import "./McpServersTab.css";

export function McpServersTab() {
  const { t } = useTranslation("settings");
  const {
    globalMcpServers,
    loadGlobalMcp,
    saveGlobalMcpServer,
    deleteGlobalMcpServer,
    toggleGlobalMcpServer,
  } = useClaudeConfigStore();

  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    loadGlobalMcp();
  }, [loadGlobalMcp]);

  const serverEntries = Object.entries(globalMcpServers);

  const handleSave = async (name: string, server: McpServer) => {
    await saveGlobalMcpServer(name, server);
    setEditing(null);
    setAdding(false);
  };

  const handleDelete = async (name: string) => {
    if (!(await showConfirm(t("mcpDeleteConfirm"), { kind: "warning" }))) return;
    await deleteGlobalMcpServer(name);
  };

  if (adding || editing !== null) {
    const editServer = editing ? globalMcpServers[editing] : undefined;
    return (
      <McpServerForm
        initialName={editing ?? undefined}
        initialServer={editServer}
        onSave={handleSave}
        onCancel={() => { setAdding(false); setEditing(null); }}
      />
    );
  }

  return (
    <div className="mcp-servers-tab">
      <div className="mcp-servers-tab__header">
        <span className="mcp-servers-tab__title">{t("mcpServers")}</span>
        <span className="mcp-servers-tab__scope">{t("globalScope")} (~/.claude.json)</span>
      </div>
      {serverEntries.length === 0 ? (
        <div className="mcp-servers-tab__empty">{t("mcpNoServers")}</div>
      ) : (
        <div className="mcp-servers-tab__list">
          {serverEntries.map(([name, server]) => (
            <div key={name} className="mcp-servers-tab__item">
              <div className="mcp-servers-tab__item-info">
                <span className="mcp-servers-tab__item-name">{name}</span>
                <span className="mcp-servers-tab__item-cmd">{server.command} {server.args?.join(" ")}</span>
              </div>
              <div className="mcp-servers-tab__item-actions">
                <button
                  className={`mcp-servers-tab__toggle-btn ${server.disabled ? "mcp-servers-tab__toggle-btn--off" : ""}`}
                  onClick={() => toggleGlobalMcpServer(name)}
                  title={server.disabled ? t("mcpDisabled") : t("mcpEnabled")}
                >
                  {server.disabled ? t("mcpDisabled") : t("mcpEnabled")}
                </button>
                <button className="mcp-servers-tab__edit-btn" onClick={() => setEditing(name)}>{t("mcpEditServer")}</button>
                <button className="mcp-servers-tab__delete-btn" onClick={() => handleDelete(name)}>×</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <button className="mcp-servers-tab__add-btn" onClick={() => setAdding(true)}>
        + {t("mcpAddServer")}
      </button>
    </div>
  );
}
