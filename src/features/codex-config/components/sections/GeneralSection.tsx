import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useRunnerSessionStore } from "@/stores/runner-session-store";
import { useCodexConfigStore } from "@/stores/codex-config-store";
import type { AgentPermission } from "@/shared/types/agent-runner";

const PERMISSIONS: { value: AgentPermission; labelKey: string }[] = [
  { value: "cli-default", labelKey: "sandboxCliDefault" },
  { value: "read-only", labelKey: "sandboxReadOnly" },
  { value: "full-access", labelKey: "sandboxFullAccess" },
];

interface GeneralSectionProps {
  folder: string;
}

export function GeneralSection({ folder }: GeneralSectionProps) {
  const { t } = useTranslation("codex-config");
  const settings = useRunnerSessionStore((s) => s.getFolderSettings("codex", folder));
  const setModel = useRunnerSessionStore((s) => s.setModel);
  const setPermission = useRunnerSessionStore((s) => s.setPermission);
  const models = useCodexConfigStore((s) => s.models);
  const loadModels = useCodexConfigStore((s) => s.loadModels);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  // Keep a model chosen earlier selectable even if the cache no longer lists it.
  const options = settings.model && !models.some((m) => m.slug === settings.model)
    ? [...models, { slug: settings.model, displayName: settings.model }]
    : models;

  return (
    <div className="claude-settings__section">
      <div className="claude-section__hint">{t("settingsApplyNotice")}</div>

      <label className="claude-settings__label">{t("model")}</label>
      <select
        className="claude-settings__select"
        value={settings.model}
        onChange={(e) => setModel("codex", folder, e.target.value)}
      >
        <option value="">{t("modelDefault")}</option>
        {options.map((m) => (
          <option key={m.slug} value={m.slug}>{m.displayName}</option>
        ))}
      </select>

      <label className="claude-settings__label">{t("sandbox")}</label>
      <select
        className="claude-settings__select"
        value={settings.permission}
        onChange={(e) => setPermission("codex", folder, e.target.value as AgentPermission)}
      >
        {PERMISSIONS.map(({ value, labelKey }) => (
          <option key={value} value={value}>{t(labelKey)}</option>
        ))}
      </select>
    </div>
  );
}
