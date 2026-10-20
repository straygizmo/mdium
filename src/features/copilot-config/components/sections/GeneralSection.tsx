import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRunnerSessionStore } from "@/stores/runner-session-store";
import { useAgentChatStore } from "@/features/agent-chat/agent-chat-store";
import type { AgentModelInfo, AgentPermission } from "@/shared/types/agent-runner";

const PERMISSIONS: { value: AgentPermission; labelKey: string }[] = [
  { value: "cli-default", labelKey: "permissionAsk" },
  { value: "read-only", labelKey: "permissionReadOnly" },
  { value: "full-access", labelKey: "permissionFullAccess" },
];

interface GeneralSectionProps {
  folder: string;
}

export function GeneralSection({ folder }: GeneralSectionProps) {
  const { t } = useTranslation("copilot-config");
  const settings = useRunnerSessionStore((s) => s.getFolderSettings("copilot", folder));
  const setModel = useRunnerSessionStore((s) => s.setModel);
  const setPermission = useRunnerSessionStore((s) => s.setPermission);
  const [models, setModels] = useState<AgentModelInfo[] | null>(null);
  const [modelsFailed, setModelsFailed] = useState(false);

  // The model catalog comes from the CLI through the agent runner (it needs a signed-in CLI).
  useEffect(() => {
    let cancelled = false;
    setModels(null);
    setModelsFailed(false);
    useAgentChatStore
      .getState()
      .listModels(folder, "copilot")
      // An empty catalog (the CLI can answer without listing models) is treated like a failure:
      // the user can still type a model id.
      .then((list) => { if (!cancelled) { setModels(list); setModelsFailed(list.length === 0); } })
      .catch(() => { if (!cancelled) { setModels([]); setModelsFailed(true); } });
    return () => { cancelled = true; };
  }, [folder]);

  // Keep a model chosen earlier selectable even if the catalog no longer lists it.
  const listed = models ?? [];
  const options = settings.model && !listed.some((m) => m.id === settings.model)
    ? [...listed, { id: settings.model, name: settings.model }]
    : listed;

  return (
    <div className="claude-settings__section">
      <div className="claude-section__hint">{t("settingsApplyNotice")}</div>

      <label className="claude-settings__label">{t("model")}</label>
      {modelsFailed ? (
        <input
          className="claude-section__input"
          value={settings.model}
          onChange={(e) => setModel("copilot", folder, e.target.value)}
          placeholder={t("modelDefault")}
          aria-label={t("model")}
        />
      ) : (
        <select
          className="claude-settings__select"
          value={settings.model}
          onChange={(e) => setModel("copilot", folder, e.target.value)}
          disabled={models === null}
        >
          <option value="">{models === null ? t("modelsLoading") : t("modelDefault")}</option>
          {options.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
      )}
      {modelsFailed && <div className="claude-section__status">{t("modelsUnavailable")}</div>}

      <label className="claude-settings__label">{t("permission")}</label>
      <select
        className="claude-settings__select"
        value={settings.permission}
        onChange={(e) => setPermission("copilot", folder, e.target.value as AgentPermission)}
      >
        {PERMISSIONS.map(({ value, labelKey }) => (
          <option key={value} value={value}>{t(labelKey)}</option>
        ))}
      </select>
    </div>
  );
}
