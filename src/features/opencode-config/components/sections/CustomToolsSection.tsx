import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { showConfirm } from "@/stores/dialog-store";
import { useTabStore } from "@/stores/tab-store";
import { useOpencodeConfigContext, toRelativeProjectPath } from "../OpencodeConfigContext";
import { ScopeToggle, type Scope } from "../shared/ScopeToggle";
import { ScopeFormWrapper } from "../shared/ScopeFormWrapper";
import { useScopeItems } from "../../hooks/useScopeItems";
import { useEditorKeyDown } from "../../hooks/useEditorKeyDown";

interface ToolFileEntry {
  file_name: string;
  tool_name: string;
  content: string;
}

export function CustomToolsSection() {
  const { t } = useTranslation("opencode-config");
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const { useRelativePaths } = useOpencodeConfigContext();

  const [globalToolFiles, setGlobalToolFiles] = useState<ToolFileEntry[]>([]);
  const [projectToolFiles, setProjectToolFiles] = useState<ToolFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [displayPath, setDisplayPath] = useState("");

  const [formScope, setFormScope] = useState<Scope>("project");
  const [editingScope, setEditingScope] = useState<Scope | null>(null);

  const [editing, setEditing] = useState<string | null>(null); // file_name
  const [adding, setAdding] = useState(false);
  const [formName, setFormName] = useState("");
  const [formExt, setFormExt] = useState(".ts");
  const [formContent, setFormContent] = useState("");

  const getToolsDir = useCallback(
    async (targetScope: Scope): Promise<string | null> => {
      if (targetScope === "global") {
        const home = await invoke<string>("get_home_dir");
        const sep = home.includes("\\") ? "\\" : "/";
        return `${home}${sep}.config${sep}opencode${sep}tools`;
      }
      if (activeFolderPath) {
        const sep = activeFolderPath.includes("\\") ? "\\" : "/";
        return `${activeFolderPath}${sep}.opencode${sep}tools`;
      }
      return null;
    },
    [activeFolderPath]
  );

  const loadAllToolFiles = useCallback(async () => {
    setLoading(true);
    try {
      const globalDir = await getToolsDir("global");
      if (globalDir) {
        const files = await invoke<ToolFileEntry[]>("list_tool_files", { baseDir: globalDir });
        setGlobalToolFiles(files);
      } else {
        setGlobalToolFiles([]);
      }
      const projectDir = await getToolsDir("project");
      if (projectDir) {
        const files = await invoke<ToolFileEntry[]>("list_tool_files", { baseDir: projectDir });
        setProjectToolFiles(files);
      } else {
        setProjectToolFiles([]);
      }
    } catch {
      setGlobalToolFiles([]);
      setProjectToolFiles([]);
    } finally {
      setLoading(false);
    }
  }, [getToolsDir]);

  useEffect(() => {
    loadAllToolFiles();
  }, [loadAllToolFiles]);

  // Derive displayPath from formScope
  useEffect(() => {
    (async () => {
      const dir = await getToolsDir(formScope);
      if (dir) {
        const sep = dir.includes("\\") ? "\\" : "/";
        setDisplayPath(`${dir}${sep}`);
      } else {
        setDisplayPath("");
      }
    })();
  }, [formScope, getToolsDir]);

  const scopedTools = useScopeItems(globalToolFiles, projectToolFiles);

  const startAdd = () => {
    setAdding(true);
    setEditing(null);
    setEditingScope(null);
    setFormScope("project");
    setFormName("");
    setFormExt(".ts");
    setFormContent("");
    resetUndo();
  };

  const startEdit = (entry: ToolFileEntry, entryScope: Scope) => {
    setEditing(entry.file_name);
    setEditingScope(entryScope);
    setFormScope(entryScope);
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
    resetUndo();
  };

  const handleCancel = () => {
    setEditing(null);
    setEditingScope(null);
    setAdding(false);
  };

  const handleSave = async () => {
    const name = formName.trim();
    if (!name) return;

    const fileName = editing ?? `${name}${formExt}`;

    // If editing and scope changed, delete from old scope first (move)
    if (editing && editingScope && editingScope !== formScope) {
      const oldDir = await getToolsDir(editingScope);
      if (oldDir) {
        await invoke("delete_tool_file", { baseDir: oldDir, fileName });
      }
    }

    const dir = await getToolsDir(formScope);
    if (!dir) return;
    await invoke("write_tool_file", { baseDir: dir, fileName, content: formContent });
    setEditing(null);
    setEditingScope(null);
    setAdding(false);
    await loadAllToolFiles();
  };

  const handleDelete = async (fileName: string, targetScope: Scope) => {
    const confirmed = await showConfirm(t("customToolDeleteConfirm", { name: fileName }), { kind: "warning" });
    if (!confirmed) return;
    const dir = await getToolsDir(targetScope);
    if (!dir) return;
    await invoke("delete_tool_file", { baseDir: dir, fileName });
    await loadAllToolFiles();
  };

  const { handleKeyDown, resetUndo } = useEditorKeyDown(formContent, setFormContent);

  const isEditing = adding || editing !== null;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
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

      {loading && (
        <div className="oc-section__empty">...</div>
      )}

      {!loading && isEditing && (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <ScopeToggle value={formScope} onChange={setFormScope} />
          <ScopeFormWrapper scope={formScope}>
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
            <div className="oc-section__field" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
              <label className="oc-section__label">{t("customToolContent")}</label>
              <textarea
                className="oc-section__textarea--agent"
                value={formContent}
                onChange={(e) => setFormContent(e.target.value)}
                onKeyDown={handleKeyDown}
                spellCheck={false}
                style={{ flex: 1, minHeight: 200 }}
              />
            </div>
          </ScopeFormWrapper>
          {displayPath && (
            <div className="oc-section__path-hint">
              {t("customToolSavePath")}:{" "}
              {useRelativePaths && formScope === "project" && activeFolderPath
                ? toRelativeProjectPath(activeFolderPath, displayPath)
                : displayPath}
            </div>
          )}
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
        </div>
      )}

      {!loading && !isEditing && (
        <>
          {scopedTools.length === 0 && (
            <div className="oc-section__empty">{t("customToolsEmpty")}</div>
          )}
          {scopedTools.map(({ scope: itemScope, data: entry }) => (
            <div
              key={`${itemScope}-${entry.file_name}`}
              className={`oc-section__item oc-section__item--${itemScope}`}
              style={{ marginBottom: 4 }}
            >
              <div className="oc-section__item-info">
                <span className="oc-section__item-name">{entry.file_name}</span>
                <span className="oc-section__item-detail">{entry.tool_name}</span>
              </div>
              <div className="oc-section__item-actions">
                <button className="oc-section__edit-btn" onClick={() => startEdit(entry, itemScope)}>
                  {t("edit")}
                </button>
                <button className="oc-section__delete-btn" onClick={() => handleDelete(entry.file_name, itemScope)}>
                  ×
                </button>
              </div>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", marginTop: 4 }}>
            <button className="oc-section__add-btn" onClick={startAdd}>
              + {t("add")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
