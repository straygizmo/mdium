import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useClaudeConfigStore } from "@/stores/claude-config-store";
import "./PluginsTab.css";

export function PluginsTab() {
  const { t } = useTranslation("claude-config");
  const plugins = useClaudeConfigStore((s) => s.claudePlugins);
  const loadClaudePlugins = useClaudeConfigStore((s) => s.loadClaudePlugins);
  const setClaudePluginEnabled = useClaudeConfigStore((s) => s.setClaudePluginEnabled);

  useEffect(() => {
    loadClaudePlugins();
  }, [loadClaudePlugins]);

  return (
    <div className="plugins-tab">
      <p className="plugins-tab__desc">{t("pluginsDescription")}</p>
      {plugins.length === 0 ? (
        <div className="plugins-tab__empty">{t("pluginsEmpty")}</div>
      ) : (
        <div className="plugins-tab__list">
          {plugins.map((p) => (
            <label key={p.key} className="plugins-tab__item">
              <input
                type="checkbox"
                checked={p.enabled}
                onChange={(e) => setClaudePluginEnabled(p.key, e.target.checked)}
              />
              <span className="plugins-tab__item-name">{p.name}</span>
              {p.marketplace && <span className="plugins-tab__item-market">{p.marketplace}</span>}
              {p.version && <span className="plugins-tab__item-version">v{p.version}</span>}
            </label>
          ))}
        </div>
      )}
      <p className="plugins-tab__notice">{t("pluginApplyNotice")}</p>
    </div>
  );
}
