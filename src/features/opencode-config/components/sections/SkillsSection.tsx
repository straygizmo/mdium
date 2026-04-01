import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { useTabStore } from "@/stores/tab-store";
import { useOpencodeConfigStore } from "@/stores/opencode-config-store";
import type { OpencodeSkill } from "@/shared/types";
import { marked } from "marked";
import { useOpencodeConfigContext, toRelativeProjectPath } from "../OpencodeConfigContext";
import {
  BUILTIN_SKILLS as REGISTRY_SKILLS,
  getMissingBuiltinSkills,
  isBuiltinSkill,
} from "../../lib/builtin-registry";
import { ScopeToggle, type Scope } from "../shared/ScopeToggle";
import { ScopeFormWrapper } from "../shared/ScopeFormWrapper";
import { useScopeItems } from "../../hooks/useScopeItems";

type SkillViewTab = "editor" | "preview";

interface SkillEntry {
  dir_name: string;
  name: string;
  description: string;
  user_invocable: boolean;
  allowed_tools: string[];
  content: string;
}

const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Front matter + content → SKILL.md string */
function buildSkillMd(name: string, description: string, body: string): string {
  const lines = ["---", `name: ${name}`];
  if (description) lines.push(`description: ${description}`);
  lines.push("---", "");
  if (body) lines.push(body);
  return lines.join("\n");
}

/** SKILL.md string → { name, description, body } */
function parseSkillMd(raw: string): { name: string; description: string; body: string } {
  let name = "";
  let description = "";
  let body = raw;

  const fmStart = raw.startsWith("---\n") || raw.startsWith("---\r\n");
  if (fmStart) {
    const endIdx = raw.indexOf("\n---", 4);
    if (endIdx !== -1) {
      const yaml = raw.substring(4, endIdx);
      for (const line of yaml.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("name:")) {
          name = trimmed.slice(5).trim().replace(/^["']|["']$/g, "");
        } else if (trimmed.startsWith("description:")) {
          description = trimmed.slice(12).trim().replace(/^["']|["']$/g, "");
        }
      }
      // body is everything after closing ---
      const afterFm = raw.indexOf("\n", endIdx + 4);
      body = afterFm !== -1 ? raw.substring(afterFm + 1) : "";
    }
  }
  return { name, description, body };
}

export function SkillsSection() {
  const { t } = useTranslation("opencode-config");
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const loadProjectSkills = useOpencodeConfigStore((s) => s.loadProjectSkills);
  const loadGlobalSkills = useOpencodeConfigStore((s) => s.loadGlobalSkills);
  const { useRelativePaths } = useOpencodeConfigContext();

  const [formScope, setFormScope] = useState<Scope>("project");
  const [editingScope, setEditingScope] = useState<Scope | null>(null);

  const [globalSkillEntries, setGlobalSkillEntries] = useState<SkillEntry[]>([]);
  const [projectSkillEntries, setProjectSkillEntries] = useState<SkillEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [displayPath, setDisplayPath] = useState("");

  // editing state
  const [editing, setEditing] = useState<string | null>(null); // dir_name or null
  const [adding, setAdding] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formBody, setFormBody] = useState("");
  const [savedBody, setSavedBody] = useState("");
  const [savedDesc, setSavedDesc] = useState("");
  const [viewTab, setViewTab] = useState<SkillViewTab>("editor");
  const [nameError, setNameError] = useState("");
  const [showBuiltinMenu, setShowBuiltinMenu] = useState(false);

  const getSkillsDir = useCallback(
    async (targetScope: Scope): Promise<string | null> => {
      if (targetScope === "global") {
        const home = await invoke<string>("get_home_dir");
        const sep = home.includes("\\") ? "\\" : "/";
        return `${home}${sep}.config${sep}opencode${sep}skills`;
      }
      if (activeFolderPath) {
        const sep = activeFolderPath.includes("\\") ? "\\" : "/";
        return `${activeFolderPath}${sep}.opencode${sep}skills`;
      }
      return null;
    },
    [activeFolderPath]
  );

  const loadAllSkills = useCallback(async () => {
    setLoading(true);
    try {
      const globalDir = await getSkillsDir("global");
      if (globalDir) {
        const entries = await invoke<SkillEntry[]>("list_skills", { baseDir: globalDir });
        setGlobalSkillEntries(entries);
      } else {
        setGlobalSkillEntries([]);
      }
      const projectDir = await getSkillsDir("project");
      if (projectDir) {
        const entries = await invoke<SkillEntry[]>("list_skills", { baseDir: projectDir });
        setProjectSkillEntries(entries);
      } else {
        setProjectSkillEntries([]);
      }
    } catch {
      setGlobalSkillEntries([]);
      setProjectSkillEntries([]);
    } finally {
      setLoading(false);
    }
  }, [getSkillsDir]);

  useEffect(() => {
    loadAllSkills();
  }, [loadAllSkills]);

  // Derive displayPath from formScope
  useEffect(() => {
    (async () => {
      const dir = await getSkillsDir(formScope);
      if (dir) {
        const sep = dir.includes("\\") ? "\\" : "/";
        setDisplayPath(`${dir}${sep}<name>${sep}SKILL.md`);
      } else {
        setDisplayPath("");
      }
    })();
  }, [formScope, getSkillsDir]);

  const scopedSkills = useScopeItems(globalSkillEntries, projectSkillEntries);

  const startAdd = () => {
    setAdding(true);
    setEditing(null);
    setEditingScope(null);
    setFormScope("project");
    setFormName("");
    setFormDesc("");
    setFormBody("");
    setSavedBody("");
    setSavedDesc("");
    setViewTab("editor");
    setNameError("");
  };

  const startEdit = (entry: SkillEntry, entryScope: Scope) => {
    const parsed = parseSkillMd(entry.content);
    setEditing(entry.dir_name);
    setEditingScope(entryScope);
    setFormScope(entryScope);
    setAdding(false);
    setFormName(parsed.name || entry.dir_name);
    setFormDesc(parsed.description);
    setSavedDesc(parsed.description);
    setFormBody(parsed.body);
    setSavedBody(parsed.body);
    setViewTab("editor");
    setNameError("");
  };

  const handleCancel = () => {
    setEditing(null);
    setAdding(false);
    setEditingScope(null);
    setNameError("");
  };

  const handleSave = async () => {
    const name = formName.trim();
    if (!name) return;
    if (!SKILL_NAME_PATTERN.test(name)) {
      setNameError(t("skillNamePatternError"));
      return;
    }

    const dirName = editing ?? name;

    // If editing and scope changed, delete from old scope dir first
    if (editing && editingScope && editingScope !== formScope) {
      const oldDir = await getSkillsDir(editingScope);
      if (oldDir) {
        await invoke("delete_skill", { baseDir: oldDir, dirName });
      }
    }

    const base = await getSkillsDir(formScope);
    if (!base) return;

    const md = buildSkillMd(name, formDesc.trim(), formBody);
    await invoke("write_skill", { baseDir: base, dirName, content: md });
    setSavedBody(formBody);
    setSavedDesc(formDesc.trim());
    setEditing(null);
    setEditingScope(null);
    setAdding(false);
    setNameError("");
    await loadAllSkills();
    loadGlobalSkills();
    if (activeFolderPath) {
      loadProjectSkills(activeFolderPath);
    }
  };

  const handleDelete = async (dirName: string, targetScope: Scope) => {
    const confirmed = await ask(t("skillDeleteConfirm", { name: dirName }), { kind: "warning" });
    if (!confirmed) return;
    const base = await getSkillsDir(targetScope);
    if (!base) return;
    await invoke("delete_skill", { baseDir: base, dirName });
    await loadAllSkills();
    loadGlobalSkills();
    if (activeFolderPath) {
      loadProjectSkills(activeFolderPath);
    }
  };

  const previewHtml = useMemo(() => {
    if (!formBody) return "";
    try {
      return marked(formBody, { async: false, gfm: true, breaks: true }) as string;
    } catch {
      return "<p>Markdown rendering error</p>";
    }
  }, [formBody]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const textarea = e.currentTarget;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const newContent =
          formBody.substring(0, start) + "  " + formBody.substring(end);
        setFormBody(newContent);
        setTimeout(() => {
          textarea.selectionStart = textarea.selectionEnd = start + 2;
        }, 0);
      }
    },
    [formBody]
  );

  // Compute missing builtin skills by comparing registry keys against all loaded skill dir_names
  const allSkillEntries = [...globalSkillEntries, ...projectSkillEntries];
  const currentSkillNames = allSkillEntries.reduce<Record<string, OpencodeSkill>>((acc, s) => {
    acc[s.dir_name] = { content: s.content, description: s.description };
    return acc;
  }, {});
  const missingBuiltins = getMissingBuiltinSkills(currentSkillNames);

  const handleAddBuiltin = async (name: string) => {
    const entry = REGISTRY_SKILLS[name];
    if (!entry) return;
    const base = await getSkillsDir("global");
    if (!base) return;
    const md = buildSkillMd(name, entry.description ?? "", entry.content);
    await invoke("write_skill", { baseDir: base, dirName: name, content: md });
    setShowBuiltinMenu(false);
    await loadAllSkills();
    loadGlobalSkills();
    if (activeFolderPath) {
      loadProjectSkills(activeFolderPath);
    }
  };

  const isEditing = adding || editing !== null;
  const isDirty = formBody !== savedBody || formDesc !== savedDesc || adding;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className="oc-section__hint">
        {t("skillsDescription")}
        {" "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            invoke("open_external_url", { url: t("skillsDocsUrl") });
          }}
          style={{ textDecoration: "none", cursor: "pointer" }}
          title={t("skillsDocsUrl")}
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
              <label className="oc-section__label">{t("skillName")}</label>
              <input
                className="oc-section__input"
                value={formName}
                onChange={(e) => {
                  setFormName(e.target.value);
                  setNameError("");
                }}
                disabled={editing !== null}
                placeholder="my-skill-name"
              />
              {nameError && (
                <span style={{ fontSize: 11, color: "var(--accent-red, #ef4444)" }}>{nameError}</span>
              )}
            </div>
            <div className="oc-section__field">
              <label className="oc-section__label">{t("skillDescription")}</label>
              <input
                className="oc-section__input"
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                placeholder={t("skillDescriptionHint")}
              />
            </div>

            <div className="oc-section__field" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
              <label className="oc-section__label">{t("skillContent")}</label>
              <div className="oc-rules__editor-panel">
                <div className="oc-rules__panel-tabs">
                  <button
                    className={`oc-rules__panel-tab${viewTab === "editor" ? " oc-rules__panel-tab--active" : ""}`}
                    onClick={() => setViewTab("editor")}
                  >
                    {t("skillTabEditor")}
                  </button>
                  <button
                    className={`oc-rules__panel-tab${viewTab === "preview" ? " oc-rules__panel-tab--active" : ""}`}
                    onClick={() => setViewTab("preview")}
                  >
                    {t("skillTabPreview")}
                  </button>
                </div>

                {viewTab === "editor" ? (
                  <textarea
                    className="oc-rules__editor-textarea"
                    value={formBody}
                    onChange={(e) => setFormBody(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={t("skillPlaceholder")}
                    spellCheck={false}
                  />
                ) : (
                  formBody ? (
                    <div
                      className="oc-rules__preview"
                      dangerouslySetInnerHTML={{ __html: previewHtml }}
                    />
                  ) : (
                    <div className="oc-rules__preview">
                      <div className="oc-rules__preview-empty">
                        {t("skillPlaceholder")}
                      </div>
                    </div>
                  )
                )}
              </div>
            </div>
          </ScopeFormWrapper>

          {displayPath && (
            <div className="oc-section__path-hint">
              {useRelativePaths && formScope === "project" && activeFolderPath
                ? toRelativeProjectPath(activeFolderPath, displayPath)
                : displayPath}
            </div>
          )}
          <div className="oc-section__form-actions" style={{ marginTop: 8, flexShrink: 0 }}>
            <button
              className="oc-section__save-btn"
              onClick={handleSave}
              disabled={!formName.trim() || (!isDirty && editing !== null)}
              style={{ opacity: formName.trim() && (isDirty || editing === null) ? 1 : 0.5 }}
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
          {scopedSkills.length === 0 && (
            <div className="oc-section__empty">{t("skillsEmpty")}</div>
          )}
          {scopedSkills.map(({ scope: itemScope, data: skill }) => (
            <div
              key={`${itemScope}-${skill.dir_name}`}
              className={`oc-section__item oc-section__item--${itemScope}`}
              style={{ marginBottom: 4 }}
            >
              <div className="oc-section__item-info">
                <span className="oc-section__item-name">
                  {skill.name || skill.dir_name}
                  {isBuiltinSkill(skill.dir_name) && (
                    <span className="oc-section__builtin-badge">Built-in</span>
                  )}
                </span>
                <span className="oc-section__item-detail">{skill.description}</span>
              </div>
              <div className="oc-section__item-actions">
                <button className="oc-section__edit-btn" onClick={() => startEdit(skill, itemScope)}>
                  {t("edit")}
                </button>
                <button className="oc-section__delete-btn" onClick={() => handleDelete(skill.dir_name, itemScope)}>
                  ×
                </button>
              </div>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", marginTop: 4, position: "relative" }}>
            <button className="oc-section__add-btn" onClick={startAdd}>
              + {t("add")}
            </button>
            {missingBuiltins.length > 0 && (
              <>
                <button
                  className="oc-section__builtin-btn"
                  onClick={() => setShowBuiltinMenu((v) => !v)}
                >
                  + Built-in
                </button>
                {showBuiltinMenu && (
                  <div className="oc-section__builtin-dropdown">
                    {missingBuiltins.map((name) => (
                      <button
                        key={name}
                        className="oc-section__builtin-dropdown-item"
                        onClick={() => handleAddBuiltin(name)}
                      >
                        {name} — {REGISTRY_SKILLS[name]?.description ?? ""}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
