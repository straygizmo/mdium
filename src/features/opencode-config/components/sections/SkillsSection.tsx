import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { useTabStore } from "@/stores/tab-store";
import { useOpencodeConfigStore } from "@/stores/opencode-config-store";
import { marked } from "marked";
import { useOpencodeConfigContext, toRelativeProjectPath } from "../OpencodeConfigContext";
import { BUILTIN_SKILLS } from "../../lib/builtin-skills";

type SkillScope = "global" | "project";
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
  const { useRelativePaths } = useOpencodeConfigContext();

  const [scope, setScope] = useState<SkillScope>("global");
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [loading, setLoading] = useState(false);

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
  const [displayPath, setDisplayPath] = useState("");

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

  const loadSkills = useCallback(async () => {
    const base = await getBaseDir();
    if (!base) {
      setSkills([]);
      setDisplayPath("");
      return;
    }
    const sep = base.includes("\\") ? "\\" : "/";
    setDisplayPath(`${base}${sep}skills${sep}<name>${sep}SKILL.md`);
    setLoading(true);
    try {
      const entries = await invoke<SkillEntry[]>("list_skills", { baseDir: base });
      setSkills(entries);
    } catch {
      setSkills([]);
    }
    setLoading(false);
  }, [getBaseDir]);

  useEffect(() => {
    setEditing(null);
    setAdding(false);
    loadSkills();
  }, [loadSkills]);

  const startAdd = () => {
    setAdding(true);
    setEditing(null);
    setFormName("");
    setFormDesc("");
    setFormBody("");
    setSavedBody("");
    setSavedDesc("");
    setViewTab("editor");
    setNameError("");
  };

  const startEdit = (skill: SkillEntry) => {
    const parsed = parseSkillMd(skill.content);
    setEditing(skill.dir_name);
    setAdding(false);
    setFormName(parsed.name || skill.dir_name);
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
    setNameError("");
  };

  const handleSave = async () => {
    const name = formName.trim();
    if (!name) return;
    if (!SKILL_NAME_PATTERN.test(name)) {
      setNameError(t("skillNamePatternError"));
      return;
    }
    const base = await getBaseDir();
    if (!base) return;

    const md = buildSkillMd(name, formDesc.trim(), formBody);
    const dirName = editing ?? name;
    await invoke("write_skill", { baseDir: base, dirName, content: md });
    setSavedBody(formBody);
    setSavedDesc(formDesc.trim());
    setEditing(null);
    setAdding(false);
    setNameError("");
    await loadSkills();
    if (scope === "project" && activeFolderPath) {
      loadProjectSkills(activeFolderPath);
    }
  };

  const handleDelete = async (dirName: string) => {
    const confirmed = await ask(t("skillDeleteConfirm", { name: dirName }), { kind: "warning" });
    if (!confirmed) return;
    const base = await getBaseDir();
    if (!base) return;
    await invoke("delete_skill", { baseDir: base, dirName });
    await loadSkills();
    if (scope === "project" && activeFolderPath) {
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

  const noProject = scope === "project" && !activeFolderPath;
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

      <div className="oc-section__scope-tabs">
        <button
          className={`oc-section__scope-tab${scope === "global" ? " oc-section__scope-tab--active" : ""}`}
          onClick={() => setScope("global")}
        >
          {t("skillScopeGlobal")}
        </button>
        <button
          className={`oc-section__scope-tab${scope === "project" ? " oc-section__scope-tab--active" : ""}`}
          onClick={() => setScope("project")}
        >
          {t("skillScopeProject")}
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
        <div className="oc-section__empty">{t("skillNoProject")}</div>
      )}

      {!noProject && loading && (
        <div className="oc-section__empty">...</div>
      )}

      {!noProject && !loading && isEditing && (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          {/* Built-In Skill selector */}
          <div style={{ marginBottom: 8 }}>
            <select
              className="oc-section__builtin-select"
              value=""
              onChange={(e) => {
                const key = e.target.value;
                if (!key) return;
                const builtin = BUILTIN_SKILLS[key];
                if (!builtin) return;
                const parsed = parseSkillMd(builtin.content);
                setFormName(builtin.name);
                setFormDesc(builtin.description);
                setFormBody(parsed.body);
              }}
            >
              <option value="">{t("skillBuiltinSelect")}</option>
              {Object.keys(BUILTIN_SKILLS).map((key) => (
                <option key={key} value={key}>{key}</option>
              ))}
            </select>
          </div>

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

      {!noProject && !loading && !isEditing && (
        <>
          {skills.length === 0 && (
            <div className="oc-section__empty">{t("skillsEmpty")}</div>
          )}
          {skills.map((skill) => (
            <div key={skill.dir_name} className="oc-section__item" style={{ marginBottom: 4 }}>
              <div className="oc-section__item-info">
                <span className="oc-section__item-name">{skill.name || skill.dir_name}</span>
                <span className="oc-section__item-detail">{skill.description}</span>
              </div>
              <div className="oc-section__item-actions">
                <button className="oc-section__edit-btn" onClick={() => startEdit(skill)}>
                  {t("edit")}
                </button>
                <button className="oc-section__delete-btn" onClick={() => handleDelete(skill.dir_name)}>
                  ×
                </button>
              </div>
            </div>
          ))}
          <button className="oc-section__add-btn" onClick={startAdd} style={{ marginTop: 4, alignSelf: "flex-start" }}>
            + {t("add")}
          </button>
        </>
      )}
    </div>
  );
}
