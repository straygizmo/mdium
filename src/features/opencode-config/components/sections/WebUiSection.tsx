import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useOpencodeConfigStore } from "@/stores/opencode-config-store";
import type { OpencodeWebUi } from "@/shared/types";

const EMPTY_WEBUI: OpencodeWebUi = {};

export function WebUiSection() {
  const { t } = useTranslation("opencode-config");
  const config = useOpencodeConfigStore((s) => s.config);
  const webui = config.webui ?? EMPTY_WEBUI;
  const setWebUi = useOpencodeConfigStore((s) => s.setWebUi);

  const [local, setLocal] = useState<OpencodeWebUi>(webui);

  useEffect(() => {
    setLocal(webui);
  }, [webui]);

  const handleSave = async () => {
    await setWebUi(local);
  };

  return (
    <div>
      <label className="oc-section__toggle">
        <span>{t("webuiEnabled")}</span>
        <input
          type="checkbox"
          checked={local.enabled ?? false}
          onChange={(e) => setLocal({ ...local, enabled: e.target.checked })}
        />
      </label>
      <div className="oc-section__field" style={{ marginTop: 8 }}>
        <label className="oc-section__label">{t("webuiHost")}</label>
        <input
          className="oc-section__input"
          value={local.host ?? ""}
          onChange={(e) => setLocal({ ...local, host: e.target.value })}
          placeholder="localhost"
        />
      </div>
      <div className="oc-section__field">
        <label className="oc-section__label">{t("webuiPort")}</label>
        <input
          className="oc-section__input"
          type="number"
          value={local.port ?? ""}
          onChange={(e) => setLocal({ ...local, port: e.target.value ? Number(e.target.value) : undefined })}
          placeholder="3000"
        />
      </div>
      <div className="oc-section__form-actions" style={{ marginTop: 12 }}>
        <button className="oc-section__save-btn" onClick={handleSave}>{t("save")}</button>
      </div>
    </div>
  );
}
