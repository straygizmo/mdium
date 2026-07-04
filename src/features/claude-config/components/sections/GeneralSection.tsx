import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import { useClaudeSessionStore } from "@/stores/claude-session-store";
import type { ClaudePermissionMode } from "@/shared/types/claude-sidecar";

const MODELS = ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"];

export function GeneralSection() {
  const { t } = useTranslation("claude-config");
  const folder = useTabStore((s) => s.activeFolderPath)!;
  const settings = useClaudeSessionStore((s) => s.getFolderSettings(folder));
  const setModel = useClaudeSessionStore((s) => s.setModel);
  const setPermissionMode = useClaudeSessionStore((s) => s.setPermissionMode);

  return (
    <div className="claude-settings__section">
      <label className="claude-settings__label">{t("model")}</label>
      <select
        className="claude-settings__select"
        value={settings.model}
        onChange={(e) => setModel(folder, e.target.value)}
      >
        <option value="">{t("modelDefault")}</option>
        {MODELS.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>

      <label className="claude-settings__label">{t("permissionMode")}</label>
      <select
        className="claude-settings__select"
        value={settings.permissionMode}
        onChange={(e) => setPermissionMode(folder, e.target.value as ClaudePermissionMode)}
      >
        <option value="default">{t("pmDefault")}</option>
        <option value="acceptEdits">{t("pmAcceptEdits")}</option>
        <option value="bypassPermissions">{t("pmBypass")}</option>
        <option value="plan">{t("pmPlan")}</option>
      </select>
    </div>
  );
}
