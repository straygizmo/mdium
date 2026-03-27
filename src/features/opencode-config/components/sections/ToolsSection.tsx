import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useOpencodeConfigStore } from "@/stores/opencode-config-store";

const EMPTY_OBJ: Record<string, boolean> = {};

const BUILTIN_TOOLS = [
  "bash", "edit", "read", "write", "glob", "grep", "list",
  "patch", "todowrite", "todoread", "webfetch", "websearch", "question",
];

export function ToolsSection() {
  const { t } = useTranslation("opencode-config");
  const config = useOpencodeConfigStore((s) => s.config);
  const tools = config.tools ?? EMPTY_OBJ;
  const setToolEnabled = useOpencodeConfigStore((s) => s.setToolEnabled);

  return (
    <div>
      <div className="oc-section__hint">
        {t("toolsDescription")}
        {" "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            invoke("open_external_url", { url: t("toolsDocsUrl") });
          }}
          style={{ textDecoration: "none", cursor: "pointer" }}
          title={t("toolsDocsUrl")}
        >
          🔗
        </a>
      </div>
      {BUILTIN_TOOLS.map((name) => {
        const enabled = tools[name] !== false;
        return (
          <label key={name} className="oc-section__toggle" style={{ marginBottom: 4 }}>
            <span className="oc-section__tool-label">
              <span className="oc-section__tool-name">{name}</span>
              <span className="oc-section__tool-desc">
                {t(`toolDesc_${name}`)}
              </span>
            </span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setToolEnabled(name, e.target.checked)}
            />
          </label>
        );
      })}
      <div className="oc-section__empty" style={{ marginTop: 8 }}>
        {t("toolsHint")}
      </div>
    </div>
  );
}
