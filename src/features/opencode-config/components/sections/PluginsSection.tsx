import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { showConfirm } from "@/stores/dialog-store";
import { useOpencodeConfigStore } from "@/stores/opencode-config-store";
import { useTabStore } from "@/stores/tab-store";
import { useOpencodeServerStore } from "@/stores/opencode-server-store";
import { BUILTIN_PLUGINS, isBuiltinPlugin } from "../../lib/builtin-registry";

const subtitleStyle: React.CSSProperties = {
  fontWeight: 600,
  marginTop: 12,
  marginBottom: 4,
};

export function PluginsSection() {
  const { t } = useTranslation("opencode-config");
  const config = useOpencodeConfigStore((s) => s.config);
  const loadConfig = useOpencodeConfigStore((s) => s.loadConfig);
  const addPlugin = useOpencodeConfigStore((s) => s.addPlugin);
  const removePlugin = useOpencodeConfigStore((s) => s.removePlugin);
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const removeServer = useOpencodeServerStore((s) => s.removeServer);

  const [globalConfigPath, setGlobalConfigPath] = useState("");
  const [adding, setAdding] = useState(false);
  const [formSpec, setFormSpec] = useState("");
  const [restarting, setRestarting] = useState(false);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  useEffect(() => {
    invoke<string>("get_home_dir").then((home) => {
      const sep = home.includes("\\") ? "\\" : "/";
      setGlobalConfigPath(`${home}${sep}.config${sep}opencode${sep}opencode.jsonc`);
    }).catch(() => {});
  }, []);

  const plugins = config.plugin ?? [];
  const customPlugins = plugins.filter((spec) => !isBuiltinPlugin(spec));

  const openUrl = (url: string) => invoke("open_external_url", { url });

  const handleToggle = async (spec: string, enabled: boolean) => {
    if (enabled) await addPlugin(spec);
    else await removePlugin(spec);
  };

  const handleAdd = async () => {
    const spec = formSpec.trim();
    if (!spec) return;
    await addPlugin(spec);
    setFormSpec("");
    setAdding(false);
  };

  const handleDelete = async (spec: string) => {
    const confirmed = await showConfirm(t("pluginDeleteConfirm", { name: spec }), { kind: "warning" });
    if (!confirmed) return;
    await removePlugin(spec);
  };

  const handleRestart = async () => {
    if (!activeFolderPath) return;
    setRestarting(true);
    try {
      // Stop the running opencode server for the active folder. It will relaunch
      // with the updated `plugin` array (reading opencode.jsonc afresh) on the
      // next chat connection via ensureOpencodeServer().
      await removeServer(activeFolderPath);
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflowY: "auto" }}>
      <div className="oc-section__hint">
        {t("pluginsDescription")}{" "}
        <a
          href="#"
          onClick={(e) => { e.preventDefault(); openUrl(t("pluginsDocsUrl")); }}
          style={{ textDecoration: "none", cursor: "pointer" }}
          title={t("pluginsDocsUrl")}
        >
          🔗
        </a>
      </div>

      {/* Restart notice + action */}
      <div className="oc-section__hint">
        {t("pluginRestartNotice")}
        <button
          className="oc-section__test-btn"
          style={{ marginLeft: 8 }}
          onClick={handleRestart}
          disabled={restarting || !activeFolderPath}
        >
          {restarting ? t("pluginRestarting") : t("pluginRestart")}
        </button>
      </div>

      {/* Built-in plugins */}
      <div style={subtitleStyle}>{t("pluginsBuiltinTitle")}</div>
      {Object.entries(BUILTIN_PLUGINS).map(([id, entry]) => {
        const enabled = plugins.includes(entry.spec);
        return (
          <div
            key={id}
            className={`oc-section__item${!enabled ? " oc-section__item--disabled" : ""}`}
            style={{ marginBottom: 4 }}
          >
            <div className="oc-section__item-info">
              <span className="oc-section__item-name">
                {id}
                <span className="oc-section__builtin-badge">Built-in</span>
                <a
                  href="#"
                  onClick={(e) => { e.preventDefault(); openUrl(entry.docsUrl); }}
                  style={{ textDecoration: "none", cursor: "pointer", marginLeft: 6 }}
                  title={entry.docsUrl}
                >
                  🔗
                </a>
              </span>
              <span className="oc-section__item-detail">{t(entry.descriptionKey)}</span>
              <span className="oc-section__item-detail" style={{ opacity: 0.6 }}>{entry.spec}</span>
            </div>
            <div className="oc-section__item-actions">
              <label className="oc-section__toggle" style={{ padding: 0 }}>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => handleToggle(entry.spec, e.target.checked)}
                />
              </label>
            </div>
          </div>
        );
      })}

      {/* Custom plugins */}
      <div style={subtitleStyle}>{t("pluginsCustomTitle")}</div>
      {customPlugins.length === 0 && <div className="oc-section__empty">{t("pluginsEmpty")}</div>}
      {customPlugins.map((spec) => (
        <div key={spec} className="oc-section__item" style={{ marginBottom: 4 }}>
          <div className="oc-section__item-info">
            <span className="oc-section__item-detail">{spec}</span>
          </div>
          <div className="oc-section__item-actions">
            <button className="oc-section__delete-btn" onClick={() => handleDelete(spec)}>×</button>
          </div>
        </div>
      ))}

      {adding ? (
        <div className="oc-section__field" style={{ marginTop: 8 }}>
          <label className="oc-section__label">{t("pluginSpec")}</label>
          <input
            className="oc-section__input"
            value={formSpec}
            onChange={(e) => setFormSpec(e.target.value)}
            placeholder={t("pluginSpecPlaceholder")}
          />
          <div className="oc-section__form-actions" style={{ marginTop: 8 }}>
            <button className="oc-section__save-btn" onClick={handleAdd}>{t("save")}</button>
            <button
              className="oc-section__cancel-btn"
              onClick={() => { setAdding(false); setFormSpec(""); }}
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 4 }}>
          <button className="oc-section__add-btn" onClick={() => setAdding(true)}>+ {t("pluginAdd")}</button>
        </div>
      )}

      {globalConfigPath && (
        <div className="oc-section__path-hint">{t("mcpSavePath")}: {globalConfigPath}</div>
      )}
    </div>
  );
}
