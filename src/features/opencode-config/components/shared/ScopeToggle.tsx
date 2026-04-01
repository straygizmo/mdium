import { useTranslation } from "react-i18next";

export type Scope = "global" | "project";

interface ScopeToggleProps {
  value: Scope;
  onChange: (scope: Scope) => void;
}

export function ScopeToggle({ value, onChange }: ScopeToggleProps) {
  const { t } = useTranslation("opencode-config");
  return (
    <label className="oc-section__scope-toggle">
      <span className="oc-section__scope-toggle-label">Global</span>
      <input
        type="checkbox"
        checked={value === "global"}
        onChange={(e) => onChange(e.target.checked ? "global" : "project")}
      />
    </label>
  );
}
