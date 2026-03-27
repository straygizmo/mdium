import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { McpServer } from "@/shared/types";

interface McpServerFormProps {
  initialName?: string;
  initialServer?: McpServer;
  onSave: (name: string, server: McpServer) => void;
  onCancel: () => void;
}

export function McpServerForm({ initialName, initialServer, onSave, onCancel }: McpServerFormProps) {
  const { t } = useTranslation("settings");
  const [name, setName] = useState(initialName ?? "");
  const [command, setCommand] = useState(initialServer?.command ?? "");
  const [args, setArgs] = useState(initialServer?.args?.join("\n") ?? "");
  const [envPairs, setEnvPairs] = useState<{ key: string; value: string }[]>(() => {
    if (!initialServer?.env) return [];
    return Object.entries(initialServer.env).map(([key, value]) => ({ key, value }));
  });

  const handleSave = () => {
    if (!name.trim() || !command.trim()) return;
    const env: Record<string, string> = {};
    for (const pair of envPairs) {
      if (pair.key.trim()) env[pair.key.trim()] = pair.value;
    }
    onSave(name.trim(), {
      type: "stdio",
      command: command.trim(),
      args: args.split("\n").map((a) => a.trim()).filter(Boolean),
      env,
      disabled: initialServer?.disabled,
    });
  };

  return (
    <div className="claude-config-form">
      <div className="claude-config-form__field">
        <label className="claude-config-form__label">{t("mcpServerName")}</label>
        <input
          className="claude-config-form__input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!!initialName}
        />
      </div>
      <div className="claude-config-form__field">
        <label className="claude-config-form__label">{t("mcpServerCommand")}</label>
        <input
          className="claude-config-form__input"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="npx, node, python..."
        />
      </div>
      <div className="claude-config-form__field">
        <label className="claude-config-form__label">{t("mcpServerArgs")}</label>
        <textarea
          className="claude-config-form__textarea"
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          rows={3}
        />
      </div>
      <div className="claude-config-form__field">
        <label className="claude-config-form__label">{t("mcpServerEnv")}</label>
        {envPairs.map((pair, i) => (
          <div key={i} className="claude-config-form__env-row">
            <input
              className="claude-config-form__input claude-config-form__input--half"
              value={pair.key}
              onChange={(e) => {
                const next = [...envPairs];
                next[i] = { ...next[i], key: e.target.value };
                setEnvPairs(next);
              }}
              placeholder={t("envKey")}
            />
            <input
              className="claude-config-form__input claude-config-form__input--half"
              value={pair.value}
              onChange={(e) => {
                const next = [...envPairs];
                next[i] = { ...next[i], value: e.target.value };
                setEnvPairs(next);
              }}
              placeholder={t("envValue")}
            />
            <button
              className="claude-config-form__remove-btn"
              onClick={() => setEnvPairs(envPairs.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>
        ))}
        <button
          className="claude-config-form__add-btn"
          onClick={() => setEnvPairs([...envPairs, { key: "", value: "" }])}
        >
          + {t("envAddVariable")}
        </button>
      </div>
      <div className="claude-config-form__actions">
        <button className="claude-config-form__save-btn" onClick={handleSave}>{t("save")}</button>
        <button className="claude-config-form__cancel-btn" onClick={onCancel}>{t("cancel")}</button>
      </div>
    </div>
  );
}
