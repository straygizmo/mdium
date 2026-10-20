import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CopilotMcpServer } from "@/shared/types";
import { ScopeToggle, type Scope } from "@/features/claude-config/components/shared/ScopeToggle";
import { ScopeFormWrapper } from "@/features/claude-config/components/shared/ScopeFormWrapper";

type McpType = CopilotMcpServer["type"];

const TYPES: McpType[] = ["local", "http", "sse"];

interface McpServerFormProps {
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  /** True while editing an existing server, whose scope cannot change. */
  scopeLocked: boolean;
  savePath: string;
  initial?: CopilotMcpServer;
  onSave: (server: CopilotMcpServer) => void;
  onCancel: () => void;
}

/** "KEY=value" lines → record. Lines without the separator are ignored. */
function parsePairs(text: string, separator: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf(separator);
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (key) out[key] = line.slice(idx + separator.length).trim();
  }
  return out;
}

function formatPairs(record: Record<string, string>, separator: string): string {
  return Object.entries(record).map(([k, v]) => `${k}${separator}${v}`).join("\n");
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
  const { t } = useTranslation("copilot-config");
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<McpType>(initial?.type ?? "local");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [args, setArgs] = useState(initial?.args.join("\n") ?? "");
  const [env, setEnv] = useState(formatPairs(initial?.env ?? {}, "="));
  const [url, setUrl] = useState(initial?.url ?? "");
  const [headers, setHeaders] = useState(formatPairs(initial?.headers ?? {}, ": "));
  const [timeout, setTimeout_] = useState(initial?.timeout !== undefined ? String(initial.timeout) : "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const canSave = name.trim() !== "" && (type === "local" ? command.trim() !== "" : url.trim() !== "");

  const handleSave = () => {
    if (!canSave) return;
    const timeoutMs = Number.parseInt(timeout, 10);
    const base: CopilotMcpServer = {
      name: name.trim(),
      type,
      args: [],
      env: {},
      headers: {},
      // The tool filter is not edited here; keep whatever the file already has.
      tools: initial?.tools,
      ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeout: timeoutMs } : {}),
      enabled,
    };
    if (type === "local") {
      onSave({
        ...base,
        command: command.trim(),
        args: args.split("\n").map((a) => a.trim()).filter(Boolean),
        env: parsePairs(env, "="),
      });
    } else {
      onSave({ ...base, url: url.trim(), headers: parsePairs(headers, ":") });
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
            {TYPES.map((value) => (
              <button
                key={value}
                type="button"
                className={`claude-section__type-tab${type === value ? " claude-section__type-tab--active" : ""}`}
                onClick={() => setType(value)}
              >
                {t(`mcpType_${value}`)}
              </button>
            ))}
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
                placeholder={"-y\n@upstash/context7-mcp"}
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
              <label className="claude-section__label">{t("mcpHeaders")}</label>
              <textarea
                className="claude-section__textarea"
                value={headers}
                onChange={(e) => setHeaders(e.target.value)}
                placeholder="Authorization: Bearer TOKEN"
                spellCheck={false}
              />
            </div>
          </>
        )}

        <div className="claude-section__field">
          <label className="claude-section__label">{t("mcpTimeout")}</label>
          <input
            className="claude-section__input"
            type="number"
            min="1"
            step="1000"
            value={timeout}
            onChange={(e) => setTimeout_(e.target.value)}
            placeholder="30000"
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
