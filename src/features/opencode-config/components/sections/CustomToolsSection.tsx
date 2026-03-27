import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { useTabStore } from "@/stores/tab-store";
import { useOpencodeConfigContext, toRelativeProjectPath } from "../OpencodeConfigContext";

type Scope = "global" | "project";

interface ToolFileEntry {
  file_name: string;
  tool_name: string;
  content: string;
}

export function CustomToolsSection() {
  const { t } = useTranslation("opencode-config");
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const { useRelativePaths } = useOpencodeConfigContext();

  const [scope, setScope] = useState<Scope>("global");
  const [tools, setTools] = useState<ToolFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [displayPath, setDisplayPath] = useState("");

  const [editing, setEditing] = useState<string | null>(null); // file_name
  const [adding, setAdding] = useState(false);
  const [formName, setFormName] = useState("");
  const [formExt, setFormExt] = useState(".ts");
  const [formContent, setFormContent] = useState("");

  const getBaseDir = useCallback(async (): Promise<string | null> => {
    if (scope === "global") {
      const home = await invoke<string>("get_home_dir");
      const sep = home.includes("\\") ? "\\" : "/";
      return `${home}${sep}.config${sep}opencode`;
    }
    if (activeFolderPath) {
      const sep = activeFolderPath.includes("\\") ? "\\" : "/";
      return `${activeFolderPath}${sep}.opencode`;
    }
    return null;
  }, [scope, activeFolderPath]);

  const loadTools = useCallback(async () => {
    const base = await getBaseDir();
    if (!base) {
      setTools([]);
      setDisplayPath("");
      return;
    }
    const sep = base.includes("\\") ? "\\" : "/";
    setDisplayPath(`${base}${sep}tools${sep}`);
    setLoading(true);
    try {
      const entries = await invoke<ToolFileEntry[]>("list_tool_files", { baseDir: base });
      setTools(entries);
    } catch {
      setTools([]);
    }
    setLoading(false);
  }, [getBaseDir]);

  useEffect(() => {
    setEditing(null);
    setAdding(false);
    loadTools();
  }, [loadTools]);

  const startAdd = () => {
    setAdding(true);
    setEditing(null);
    setFormName("");
    setFormExt(".ts");
    setFormContent("");
  };

  const startEdit = (entry: ToolFileEntry) => {
    setEditing(entry.file_name);
    setAdding(false);
    // split filename into name + extension
    const dotIdx = entry.file_name.lastIndexOf(".");
    if (dotIdx > 0) {
      setFormName(entry.file_name.substring(0, dotIdx));
      setFormExt(entry.file_name.substring(dotIdx));
    } else {
      setFormName(entry.file_name);
      setFormExt("");
    }
    setFormContent(entry.content);
  };

  const handleCancel = () => {
    setEditing(null);
    setAdding(false);
  };

  const handleSave = async () => {
    const name = formName.trim();
    if (!name) return;
    const base = await getBaseDir();
    if (!base) return;

    const fileName = editing ?? `${name}${formExt}`;
    await invoke("write_tool_file", { baseDir: base, fileName, content: formContent });
    setEditing(null);
    setAdding(false);
    await loadTools();
  };

  const handleDelete = async (fileName: string) => {
    const confirmed = await ask(t("customToolDeleteConfirm", { name: fileName }), { kind: "warning" });
    if (!confirmed) return;
    const base = await getBaseDir();
    if (!base) return;
    await invoke("delete_tool_file", { baseDir: base, fileName });
    await loadTools();
  };

  const handleScopeChange = (newScope: Scope) => {
    setScope(newScope);
    setEditing(null);
    setAdding(false);
  };

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const textarea = e.currentTarget;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const newContent =
          formContent.substring(0, start) + "  " + formContent.substring(end);
        setFormContent(newContent);
        setTimeout(() => {
          textarea.selectionStart = textarea.selectionEnd = start + 2;
        }, 0);
      }
    },
    [formContent]
  );

  const noProject = scope === "project" && !activeFolderPath;
  const isEditing = adding || editing !== null;

  return (
    <div>
      <div className="oc-section__hint">
        {t("customToolsDescription")}
        {" "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            invoke("open_external_url", { url: t("customToolsDocsUrl") });
          }}
          style={{ textDecoration: "none", cursor: "pointer" }}
          title={t("customToolsDocsUrl")}
        >
          🔗
        </a>
      </div>

      <div className="oc-section__scope-tabs">
        <button
          className={`oc-section__scope-tab${scope === "global" ? " oc-section__scope-tab--active" : ""}`}
          onClick={() => handleScopeChange("global")}
        >
          {t("customToolScopeGlobal")}
        </button>
        <button
          className={`oc-section__scope-tab${scope === "project" ? " oc-section__scope-tab--active" : ""}`}
          onClick={() => handleScopeChange("project")}
        >
          {t("customToolScopeProject")}
        </button>
      </div>

      {displayPath && (
        <div className="oc-section__path-hint">
          {useRelativePaths && scope === "project" && activeFolderPath
            ? toRelativeProjectPath(activeFolderPath, displayPath)
            : displayPath}
        </div>
      )}

      {noProject && (
        <div className="oc-section__empty">{t("customToolNoProject")}</div>
      )}

      {!noProject && loading && (
        <div className="oc-section__empty">...</div>
      )}

      {!noProject && !loading && isEditing && (
        <>
          <div className="oc-section__field">
            <label className="oc-section__label">{t("customToolFileName")}</label>
            <div style={{ display: "flex", gap: 4 }}>
              <input
                className="oc-section__input"
                style={{ flex: 1 }}
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                disabled={editing !== null}
                placeholder="my-tool"
              />
              {adding && (
                <select
                  className="oc-section__input"
                  style={{ width: 70 }}
                  value={formExt}
                  onChange={(e) => setFormExt(e.target.value)}
                >
                  <option value=".ts">.ts</option>
                  <option value=".js">.js</option>
                </select>
              )}
            </div>
          </div>
          <div className="oc-section__field">
            <label className="oc-section__label">{t("customToolContent")}</label>
            <textarea
              className="oc-section__textarea--agent"
              value={formContent}
              onChange={(e) => setFormContent(e.target.value)}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              style={{ minHeight: 200 }}
            />
          </div>
          <div className="oc-section__form-actions" style={{ marginTop: 8 }}>
            <button
              className="oc-section__save-btn"
              onClick={handleSave}
              disabled={!formName.trim()}
              style={{ opacity: formName.trim() ? 1 : 0.5 }}
            >
              {t("save")}
            </button>
            <button className="oc-section__cancel-btn" onClick={handleCancel}>
              {t("cancel")}
            </button>
          </div>
        </>
      )}

      {!noProject && !loading && !isEditing && (
        <>
          {tools.length === 0 && (
            <div className="oc-section__empty">{t("customToolsEmpty")}</div>
          )}
          {tools.map((entry) => (
            <div key={entry.file_name} className="oc-section__item" style={{ marginBottom: 4 }}>
              <div className="oc-section__item-info">
                <span className="oc-section__item-name">{entry.file_name}</span>
                <span className="oc-section__item-detail">{entry.tool_name}</span>
              </div>
              <div className="oc-section__item-actions">
                <button className="oc-section__edit-btn" onClick={() => startEdit(entry)}>
                  {t("edit")}
                </button>
                <button className="oc-section__delete-btn" onClick={() => handleDelete(entry.file_name)}>
                  ×
                </button>
              </div>
            </div>
          ))}
          <button className="oc-section__add-btn" onClick={startAdd} style={{ marginTop: 4 }}>
            + {t("add")}
          </button>
        </>
      )}
    </div>
  );
}
