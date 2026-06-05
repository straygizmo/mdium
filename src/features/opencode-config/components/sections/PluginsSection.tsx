import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { showConfirm } from "@/stores/dialog-store";
import { useOpencodeConfigStore } from "@/stores/opencode-config-store";
import { useTabStore } from "@/stores/tab-store";
import { useOpencodeServerStore } from "@/stores/opencode-server-store";
import {
  BUILTIN_PLUGINS,
  getMissingBuiltinPlugins,
  getBuiltinPluginIdBySpec,
} from "../../lib/builtin-registry";

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
  const [showBuiltinMenu, setShowBuiltinMenu] = useState(false);
  const builtinMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  useEffect(() => {
    invoke<string>("get_home_dir").then((home) => {
      const sep = home.includes("\\") ? "\\" : "/";
      setGlobalConfigPath(`${home}${sep}.config${sep}opencode${sep}opencode.jsonc`);
    }).catch(() => {});
  }, []);

  // Close builtin dropdown on outside click
  useEffect(() => {
    if (!showBuiltinMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (builtinMenuRef.current && !builtinMenuRef.current.contains(e.target as Node)) {
        setShowBuiltinMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showBuiltinMenu]);

  const plugins = config.plugin ?? [];
  const missingBuiltins = getMissingBuiltinPlugins(plugins);

  const openUrl = (url: string) => invoke("open_external_url", { url });

  const handleAdd = async () => {
    const spec = formSpec.trim();
    if (!spec) return;
    await addPlugin(spec);
    setFormSpec("");
    setAdding(false);
  };

  const handleAddBuiltin = async (id: string) => {
    const entry = BUILTIN_PLUGINS[id];
    if (!entry) return;
    await addPlugin(entry.spec);
    setShowBuiltinMenu(false);
  };

  const handleDelete = async (spec: string) => {
    const id = getBuiltinPluginIdBySpec(spec);
    const confirmed = await showConfirm(t("pluginDeleteConfirm", { name: id ?? spec }), { kind: "warning" });
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

      {plugins.length === 0 && <div className="oc-section__empty">{t("pluginsEmpty")}</div>}
      {plugins.map((spec) => {
        const builtinId = getBuiltinPluginIdBySpec(spec);
        const entry = builtinId ? BUILTIN_PLUGINS[builtinId] : undefined;
        return (
          <div key={spec} className="oc-section__item" style={{ marginBottom: 4 }}>
            <div className="oc-section__item-info">
              <span className="oc-section__item-name">
                {builtinId ?? spec}
                {entry && (
                  <>
                    <span className="oc-section__builtin-badge">{t("builtin")}</span>
                    <a
                      href="#"
                      onClick={(e) => { e.preventDefault(); openUrl(entry.docsUrl); }}
                      style={{ textDecoration: "none", cursor: "pointer", marginLeft: 6 }}
                      title={entry.docsUrl}
                    >
                      🔗
                    </a>
                  </>
                )}
              </span>
              <span className="oc-section__item-detail">
                {entry ? t(entry.descriptionKey) : spec}
              </span>
              {entry && (
                <span className="oc-section__item-detail" style={{ opacity: 0.6 }}>{spec}</span>
              )}
            </div>
            <div className="oc-section__item-actions">
              <button className="oc-section__delete-btn" onClick={() => handleDelete(spec)}>×</button>
            </div>
          </div>
        );
      })}

      {adding && (
        <div className="oc-section__field" style={{ marginTop: 8 }}>
          <label className="oc-section__label">{t("pluginSpec")}</label>
          <input
            className="oc-section__input"
            value={formSpec}
            onChange={(e) => setFormSpec(e.target.value)}
            placeholder={t("pluginSpecPlaceholder")}
          />
          <div className="oc-section__form-actions" style={{ marginTop: 8 }}>
            <button className="oc-section__save-btn" onClick={handleAdd} disabled={!formSpec.trim()}>{t("save")}</button>
            <button
              className="oc-section__cancel-btn"
              onClick={() => { setAdding(false); setFormSpec(""); }}
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}

      {!adding && (
        <div style={{ display: "flex", alignItems: "center", marginTop: 4, position: "relative" }}>
          <button className="oc-section__add-btn" onClick={() => setAdding(true)}>+ {t("add")}</button>
          {missingBuiltins.length > 0 && (
            <div ref={builtinMenuRef} style={{ position: "relative" }}>
              <button className="oc-section__builtin-btn" onClick={() => setShowBuiltinMenu((v) => !v)}>
                + {t("builtin")}
              </button>
              {showBuiltinMenu && (
                <div
                  className="oc-section__builtin-dropdown"
                  ref={(el) => {
                    if (el?.parentElement) {
                      let container: HTMLElement | null = el.parentElement;
                      while (container && !container.classList.contains("oc-panel__body") && !container.classList.contains("oc-dialog__body")) {
                        container = container.parentElement;
                      }
                      const containerTop = container ? container.getBoundingClientRect().top : 0;
                      const buttonTop = el.parentElement.getBoundingClientRect().top;
                      el.style.maxHeight = `${Math.max(buttonTop - containerTop - 8, 80)}px`;
                    }
                  }}
                >
                  {missingBuiltins.map((id) => (
                    <button key={id} className="oc-section__builtin-dropdown-item" onClick={() => handleAddBuiltin(id)}>
                      <span className="oc-section__builtin-dropdown-name">{id}</span>
                      <span className="oc-section__builtin-dropdown-desc">{t(BUILTIN_PLUGINS[id].descriptionKey)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {globalConfigPath && (
        <div className="oc-section__path-hint">{t("mcpSavePath")}: {globalConfigPath}</div>
      )}
    </div>
  );
}
