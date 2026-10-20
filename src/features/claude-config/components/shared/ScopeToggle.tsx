import { useTranslation } from "react-i18next";

export type Scope = "global" | "project";

interface ScopeToggleProps {
  value: Scope;
  onChange: (scope: Scope) => void;
  /** Lock the scope, e.g. while editing an item that already lives in one scope. */
  disabled?: boolean;
}

export function ScopeToggle({ value, onChange, disabled }: ScopeToggleProps) {
  const { t } = useTranslation("claude-config");
  return (
    <label className="claude-section__scope-toggle">
      <span className="claude-section__scope-toggle-label">{t("scopeGlobal")}</span>
      <input
        type="checkbox"
        data-switch
        role="switch"
        checked={value === "global"}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked ? "global" : "project")}
      />
    </label>
  );
}
