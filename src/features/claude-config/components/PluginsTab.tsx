import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useClaudeConfigStore } from "@/stores/claude-config-store";
import "./PluginsTab.css";

export function PluginsTab() {
  const { t } = useTranslation("claude-config");
  const plugins = useClaudeConfigStore((s) => s.claudePlugins);
  const loadClaudePlugins = useClaudeConfigStore((s) => s.loadClaudePlugins);
  const setClaudePluginEnabled = useClaudeConfigStore((s) => s.setClaudePluginEnabled);

  const [settingsPath, setSettingsPath] = useState("");

  useEffect(() => {
    loadClaudePlugins();
  }, [loadClaudePlugins]);

  useEffect(() => {
    invoke<string>("get_home_dir")
      .then((home) => {
        const sep = home.includes("\\") ? "\\" : "/";
        setSettingsPath(`${home}${sep}.claude${sep}settings.json`);
      })
      .catch(() => {});
  }, []);

  const openUrl = (url: string) => invoke("open_external_url", { url });

  return (
    <div className="plugins-tab">
      <div className="plugins-tab__hint">
        {t("pluginsDescription")}{" "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            openUrl(t("pluginsDocsUrl"));
          }}
          className="plugins-tab__doc-link"
          title={t("pluginsDocsUrl")}
        >
          🔗
        </a>
      </div>

      <div className="plugins-tab__hint">{t("pluginApplyNotice")}</div>

      {plugins.length === 0 ? (
        <div className="plugins-tab__empty">{t("pluginsEmpty")}</div>
      ) : (
        plugins.map((p) => (
          <div
            key={p.key}
            className={`plugins-tab__item${p.enabled ? "" : " plugins-tab__item--disabled"}`}
          >
            <div className="plugins-tab__item-info">
              <span className="plugins-tab__item-name">{p.name}</span>
              <span className="plugins-tab__item-detail">
                {p.marketplace}
                {p.version ? ` · v${p.version}` : ""}
              </span>
            </div>
            <div className="plugins-tab__item-actions">
              <label className="plugins-tab__toggle">
                <input
                  type="checkbox"
                  checked={p.enabled}
                  onChange={async (e) => {
                    try {
                      await setClaudePluginEnabled(p.key, e.target.checked);
                    } catch {
                      // store already reported the error
                    }
                  }}
                />
              </label>
            </div>
          </div>
        ))
      )}

      {settingsPath && (
        <div className="plugins-tab__path-hint">
          {t("pluginsSavePath")}: {settingsPath}
        </div>
      )}
    </div>
  );
}
