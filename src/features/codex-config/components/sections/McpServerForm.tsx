import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CodexMcpServer } from "@/shared/types";
import { ScopeToggle, type Scope } from "@/features/claude-config/components/shared/ScopeToggle";
import { ScopeFormWrapper } from "@/features/claude-config/components/shared/ScopeFormWrapper";

type McpType = "local" | "remote";

interface McpServerFormProps {
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  /** True while editing an existing server, whose scope cannot change. */
  scopeLocked: boolean;
  savePath: string;
  initial?: CodexMcpServer;
  onSave: (server: CodexMcpServer) => void;
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
  initial,
  onSave,
  onCancel,
}: McpServerFormProps) {
  const { t } = useTranslation("codex-config");
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<McpType>(initial?.url ? "remote" : "local");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [args, setArgs] = useState(initial?.args.join("\n") ?? "");
  const [env, setEnv] = useState(formatEnv(initial?.env));
  const [url, setUrl] = useState(initial?.url ?? "");
  const [bearerTokenEnvVar, setBearerTokenEnvVar] = useState(initial?.bearerTokenEnvVar ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const canSave = name.trim() !== "" && (type === "local" ? command.trim() !== "" : url.trim() !== "");

  const handleSave = () => {
    if (!canSave) return;
    const base: CodexMcpServer = {
      name: name.trim(),
      args: [],
      env: {},
      enabled,
      // Timeouts are not edited here; keep whatever the file already has.
      startupTimeoutSec: initial?.startupTimeoutSec,
      toolTimeoutSec: initial?.toolTimeoutSec,
    };
    if (type === "remote") {
      onSave({
        ...base,
        url: url.trim(),
        ...(bearerTokenEnvVar.trim() ? { bearerTokenEnvVar: bearerTokenEnvVar.trim() } : {}),
      });
    } else {
      onSave({
        ...base,
        command: command.trim(),
        args: args.split("\n").map((a) => a.trim()).filter(Boolean),
        env: parseEnv(env),
      });
    }
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
            disabled={!!initial}
          />
        </div>

        <div className="claude-section__field">
          <label className="claude-section__label">{t("mcpType")}</label>
          <div className="claude-section__type-tabs">
            <button
              type="button"
              className={`claude-section__type-tab${type === "local" ? " claude-section__type-tab--active" : ""}`}
              onClick={() => setType("local")}
            >
              {t("mcpTypeLocal")}
            </button>
            <button
              type="button"
              className={`claude-section__type-tab${type === "remote" ? " claude-section__type-tab--active" : ""}`}
              onClick={() => setType("remote")}
            >
              {t("mcpTypeRemote")}
            </button>
          </div>
        </div>

        {type === "local" ? (
          <>
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
          </>
        ) : (
          <>
            <div className="claude-section__field">
              <label className="claude-section__label">{t("mcpUrl")}</label>
              <input
                className="claude-section__input"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://mcp.example.com/mcp"
              />
            </div>
            <div className="claude-section__field">
              <label className="claude-section__label">{t("mcpBearerTokenEnvVar")}</label>
              <input
                className="claude-section__input"
                value={bearerTokenEnvVar}
                onChange={(e) => setBearerTokenEnvVar(e.target.value)}
                placeholder="EXAMPLE_TOKEN"
              />
            </div>
          </>
        )}

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
