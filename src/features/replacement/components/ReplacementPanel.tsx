import { useTranslation } from "react-i18next";
import { useSettingsStore } from "@/stores/settings-store";
import { findDuplicateTos } from "@/shared/lib/replacement";
import type { ReplacementRule } from "@/shared/types";
import "./ReplacementPanel.css";

export function ReplacementPanel() {
  const { t } = useTranslation("replacement");
  const replacement = useSettingsStore((s) => s.replacement);
  const setReplacement = useSettingsStore((s) => s.setReplacement);

  const duplicateTos = findDuplicateTos(replacement.rules);

  const updateRule = (id: string, patch: Partial<ReplacementRule>) => {
    setReplacement({
      ...replacement,
      rules: replacement.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    });
  };

  const addRule = () => {
    setReplacement({
      ...replacement,
      rules: [
        ...replacement.rules,
        { id: crypto.randomUUID(), from: "", to: "", enabled: true },
      ],
    });
  };

  const deleteRule = (id: string) => {
    setReplacement({
      ...replacement,
      rules: replacement.rules.filter((r) => r.id !== id),
    });
  };

  return (
    <div className="replacement-panel">
      <p className="replacement-panel__guidance">{t("guidance")}</p>

      <div className="replacement-panel__header">
        <label className="replacement-panel__toggle">
          <input
            type="checkbox"
            checked={replacement.enabled}
            onChange={(e) => setReplacement({ ...replacement, enabled: e.target.checked })}
          />
          {t("enabled")}
        </label>
        <button className="replacement-panel__btn" onClick={addRule}>
          + {t("addRule")}
        </button>
      </div>

      <div className="replacement-panel__rules">
        {replacement.rules.map((rule) => (
          <div className="replacement-panel__rule" key={rule.id}>
            <input
              type="checkbox"
              checked={rule.enabled}
              onChange={(e) => updateRule(rule.id, { enabled: e.target.checked })}
            />
            <input
              type="text"
              className={`replacement-panel__input${rule.from === "" ? " replacement-panel__input--invalid" : ""}`}
              value={rule.from}
              placeholder={t("fromPlaceholder")}
              onChange={(e) => updateRule(rule.id, { from: e.target.value })}
            />
            <span className="replacement-panel__arrow">→</span>
            <input
              type="text"
              className="replacement-panel__input"
              value={rule.to}
              placeholder={t("toPlaceholder")}
              onChange={(e) => updateRule(rule.id, { to: e.target.value })}
            />
            <button
              className="replacement-panel__icon-btn"
              onClick={() => deleteRule(rule.id)}
              title={t("deleteRule")}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {duplicateTos.map((to) => (
        <p className="replacement-panel__warning" key={to}>
          ⚠ {t("duplicateToWarning", { value: to })}
        </p>
      ))}
    </div>
  );
}
