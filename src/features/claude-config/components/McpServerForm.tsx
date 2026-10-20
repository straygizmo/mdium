import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { McpServer } from "@/shared/types";
import { ScopeToggle, type Scope } from "./shared/ScopeToggle";
import { ScopeFormWrapper } from "./shared/ScopeFormWrapper";

interface McpServerFormProps {
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  /** True while editing an existing server, whose scope cannot change. */
  scopeLocked: boolean;
  savePath: string;
  initialName?: string;
  initialServer?: McpServer;
  onSave: (name: string, server: McpServer) => void;
  onCancel: () => void;
}

/** "KEY=value" lines → env record. Lines without "=" are ignored. */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (key) env[key] = line.slice(idx + 1).trim();
  }
  return env;
}

function formatEnv(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
}

export function McpServerForm({
  scope,
  onScopeChange,
  scopeLocked,
  savePath,
  initialName,
  initialServer,
  onSave,
  onCancel,
}: McpServerFormProps) {
  const { t } = useTranslation("claude-config");
  const [name, setName] = useState(initialName ?? "");
  const [command, setCommand] = useState(initialServer?.command ?? "");
  const [args, setArgs] = useState(initialServer?.args?.join("\n") ?? "");
  const [env, setEnv] = useState(formatEnv(initialServer?.env));
  const [enabled, setEnabled] = useState(!initialServer?.disabled);

  const canSave = name.trim() !== "" && command.trim() !== "";

  const handleSave = () => {
    if (!canSave) return;
    onSave(name.trim(), {
      type: "stdio",
      command: command.trim(),
      args: args.split("\n").map((a) => a.trim()).filter(Boolean),
      env: parseEnv(env),
      ...(enabled ? {} : { disabled: true }),
    });
  };

  return (
    <div className="claude-section">
      <ScopeToggle value={scope} onChange={onScopeChange} disabled={scopeLocked} />

      <ScopeFormWrapper scope={scope}>
        <div className="claude-section__field">
          <label className="claude-section__label">{t("mcpName")}</label>
          <input
            className="claude-section__input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!!initialName}
          />
        </div>
        <div className="claude-section__field">
          <label className="claude-section__label">{t("mcpCommand")}</label>
          <input
            className="claude-section__input"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="npx"
          />
        </div>
        <div className="claude-section__field">
          <label className="claude-section__label">{t("mcpArgs")}</label>
          <textarea
            className="claude-section__textarea"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder={"-y\n@modelcontextprotocol/server-github"}
            spellCheck={false}
          />
        </div>
        <div className="claude-section__field">
          <label className="claude-section__label">{t("mcpEnv")}</label>
          <textarea
            className="claude-section__textarea"
            value={env}
            onChange={(e) => setEnv(e.target.value)}
            placeholder="KEY=value"
            spellCheck={false}
          />
        </div>
        <label className="claude-section__toggle claude-section__toggle--inline">
          <span>{t("mcpEnabled")}</span>
          <input
            type="checkbox"
            data-switch
            role="switch"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
        </label>
      </ScopeFormWrapper>

      {savePath && (
        <div className="claude-section__path-hint">
          {t("mcpSavePath")}: {savePath}
        </div>
      )}
      <div className="claude-section__form-actions">
        <button className="claude-section__save-btn" onClick={handleSave} disabled={!canSave}>
          {t("save")}
        </button>
        <button className="claude-section__cancel-btn" onClick={onCancel}>
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}
