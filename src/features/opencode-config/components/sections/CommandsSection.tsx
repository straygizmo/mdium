import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { useOpencodeConfigStore } from "@/stores/opencode-config-store";
import { useTabStore } from "@/stores/tab-store";
import type { OpencodeCommand } from "@/shared/types";
import { useOpencodeConfigContext, toRelativeProjectPath } from "../OpencodeConfigContext";
import {
  BUILTIN_COMMANDS as REGISTRY_COMMANDS,
  getMissingBuiltinCommands,
  isBuiltinCommand,
} from "../../lib/builtin-registry";
import { marked } from "marked";
import { ScopeToggle, type Scope } from "../shared/ScopeToggle";
import { ScopeFormWrapper } from "../shared/ScopeFormWrapper";
import { useScopeItems } from "../../hooks/useScopeItems";

type ViewTab = "editor" | "preview";

const EMPTY_COMMANDS: Record<string, OpencodeCommand> = {};

export function CommandsSection() {
  const { t } = useTranslation("opencode-config");
  const config = useOpencodeConfigStore((s) => s.config);
  const projectCommands = useOpencodeConfigStore((s) => s.projectCommands);
  const saveCommand = useOpencodeConfigStore((s) => s.saveCommand);
  const deleteCommand = useOpencodeConfigStore((s) => s.deleteCommand);
  const loadConfig = useOpencodeConfigStore((s) => s.loadConfig);
  const loadProjectCommands = useOpencodeConfigStore((s) => s.loadProjectCommands);
  const saveProjectCommand = useOpencodeConfigStore((s) => s.saveProjectCommand);
  const deleteProjectCommand = useOpencodeConfigStore((s) => s.deleteProjectCommand);
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const { useRelativePaths } = useOpencodeConfigContext();

  const [formScope, setFormScope] = useState<Scope>("project");
  const [editingScope, setEditingScope] = useState<Scope | null>(null);
  const [globalConfigPath, setGlobalConfigPath] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [formName, setFormName] = useState("");
  const [formContent, setFormContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [viewTab, setViewTab] = useState<ViewTab>("editor");
  const [showBuiltinMenu, setShowBuiltinMenu] = useState(false);

  // --- Preview (same pattern as AgentsSection) ---
  const { frontMatter: cmdFrontMatter, previewHtml } = useMemo(() => {
    if (!formContent) return { frontMatter: null, previewHtml: "" };
    let body = formContent;
    let meta: Record<string, string> | null = null;
    if (body.startsWith("---\n") || body.startsWith("---\r\n")) {
      const endIdx = body.indexOf("\n---", 4);
      if (endIdx !== -1) {
        const yaml = body.slice(4, endIdx).trim();
        const parsed: Record<string, string> = {};
        for (const line of yaml.split("\n")) {
          const colon = line.indexOf(":");
          if (colon > 0) {
            const key = line.slice(0, colon).trim();
            const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
            if (key) parsed[key] = value;
          }
        }
        if (Object.keys(parsed).length > 0) meta = parsed;
        const afterFm = body.indexOf("\n", endIdx + 4);
        body = afterFm !== -1 ? body.substring(afterFm + 1) : "";
      }
    }
    try { return { frontMatter: meta, previewHtml: marked(body, { async: false, gfm: true, breaks: true }) as string }; }
    catch { return { frontMatter: meta, previewHtml: "<p>Markdown rendering error</p>" }; }
  }, [formContent]);

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

  useEffect(() => {
    invoke<string>("get_home_dir").then((home) => {
      const sep = home.includes("\\") ? "\\" : "/";
      setGlobalConfigPath(`${home}${sep}.config${sep}opencode${sep}opencode.jsonc`);
    });
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  useEffect(() => {
    if (activeFolderPath) loadProjectCommands(activeFolderPath);
  }, [activeFolderPath, loadProjectCommands]);

  const globalEntries = useMemo(
    () => Object.entries(config.command ?? EMPTY_COMMANDS).map(([name, cmd]) => ({ name, cmd })),
    [config.command]
  );
  const projectCmdEntries = useMemo(
    () => Object.entries(projectCommands).map(([name, cmd]) => ({ name, cmd })),
    [projectCommands]
  );
  const scopedEntries = useScopeItems(globalEntries, projectCmdEntries);

  const allCommands = useMemo(
    () => ({ ...config.command, ...projectCommands }),
    [config.command, projectCommands]
  );
  const missingBuiltins = getMissingBuiltinCommands(allCommands);

  const handleAddBuiltin = async (name: string) => {
    const entry = REGISTRY_COMMANDS[name];
    if (!entry) return;
    setFormScope("global");
    await saveCommand(name, { ...entry });
    setShowBuiltinMenu(false);
  };

  /** Build frontmatter + template string from command fields */
  const buildCommandContent = (cmd: OpencodeCommand): string => {
    const fmLines: string[] = [];
    if (cmd.description) fmLines.push(`description: ${cmd.description}`);
    if (cmd.agent) fmLines.push(`agent: ${cmd.agent}`);
    if (cmd.model) fmLines.push(`model: ${cmd.model}`);
    if (fmLines.length > 0) {
      return `---\n${fmLines.join("\n")}\n---\n\n${cmd.template}`;
    }
    return cmd.template;
  };

  /** Parse content textarea back into command fields */
  const parseCommandContent = (content: string): Omit<OpencodeCommand, "template"> & { template: string } => {
    let body = content;
    let description: string | undefined;
    let agent: string | undefined;
    let model: string | undefined;
    if (body.startsWith("---\n") || body.startsWith("---\r\n")) {
      const endIdx = body.indexOf("\n---", 4);
      if (endIdx !== -1) {
        const yaml = body.slice(4, endIdx);
        for (const line of yaml.split("\n")) {
          const colon = line.indexOf(":");
          if (colon > 0) {
            const key = line.slice(0, colon).trim();
            const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
            if (key === "description" && value) description = value;
            else if (key === "agent" && value) agent = value;
            else if (key === "model" && value) model = value;
          }
        }
        const afterFm = body.indexOf("\n", endIdx + 4);
        body = afterFm !== -1 ? body.substring(afterFm + 1) : "";
      }
    }
    return { template: body.trim(), description, agent, model };
  };

  const startEdit = (name: string, cmd: OpencodeCommand, itemScope: Scope) => {
    setEditing(name);
    setEditingScope(itemScope);
    setFormScope(itemScope);
    setFormName(name);
    const content = buildCommandContent(cmd);
    setFormContent(content);
    setSavedContent(content);
    setViewTab("editor");
  };

  const startAdd = () => {
    setAdding(true);
    setFormScope("project");
    setEditingScope(null);
    setFormName("");
    setFormContent("---\ndescription: \n---\n\n");
    setSavedContent("");
    setViewTab("editor");
  };

  const handleSave = async () => {
    const name = formName.trim();
    const parsed = parseCommandContent(formContent);
    if (!name || !parsed.template) return;
    const cmdObj: OpencodeCommand = {
      template: parsed.template,
      description: parsed.description,
      agent: parsed.agent,
      model: parsed.model,
    };

    // Handle scope move when editing
    if (editing && editingScope && editingScope !== formScope) {
      if (editingScope === "global") {
        await deleteCommand(editing);
      } else {
        await deleteProjectCommand(activeFolderPath!, editing);
      }
    }

    if (formScope === "global") {
      await saveCommand(name, cmdObj);
    } else if (activeFolderPath) {
      await saveProjectCommand(activeFolderPath, name, cmdObj);
    }

    await loadConfig();
    if (activeFolderPath) await loadProjectCommands(activeFolderPath);

    setEditing(null);
    setAdding(false);
    setEditingScope(null);
  };

  const handleDelete = async (name: string, itemScope: Scope) => {
    const confirmed = await ask(t("commandDeleteConfirm", { name }), { kind: "warning" });
    if (!confirmed) return;
    if (itemScope === "global") {
      await deleteCommand(name);
    } else if (activeFolderPath) {
      await deleteProjectCommand(activeFolderPath, name);
    }
  };

  const handleCancel = () => {
    setEditing(null);
    setAdding(false);
    setEditingScope(null);
  };

  const isEditing = adding || editing !== null;

  const displayPath = formScope === "global"
    ? globalConfigPath
    : activeFolderPath
      ? `${activeFolderPath}${activeFolderPath.includes("\\") ? "\\" : "/"}opencode.jsonc`
      : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className="oc-section__hint">
        {t("commandsDescription")}
        {" "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            invoke("open_external_url", { url: t("commandsDocsUrl") });
          }}
          style={{ textDecoration: "none", cursor: "pointer" }}
          title={t("commandsDocsUrl")}
        >
          🔗
        </a>
      </div>

      {isEditing ? (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <ScopeToggle value={formScope} onChange={setFormScope} />
          <ScopeFormWrapper scope={formScope}>
          <div className="oc-section__field">
            <label className="oc-section__label">{t("commandName")} <span className="oc-section__label-hint">{t("commandNameHint")}</span></label>
            <input className="oc-section__input" value={formName} onChange={(e) => setFormName(e.target.value)} disabled={editing !== null} />
          </div>
          <div className="oc-section__field" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <label className="oc-section__label">{t("commandTemplate")} <span className="oc-section__label-hint">{t("commandTemplateHint")}</span></label>
            <div className="oc-rules__editor-panel">
              <div className="oc-rules__panel-tabs">
                <button
                  className={`oc-rules__panel-tab${viewTab === "editor" ? " oc-rules__panel-tab--active" : ""}`}
                  onClick={() => setViewTab("editor")}
                >
                  {t("commandTabEditor")}
                </button>
                <button
                  className={`oc-rules__panel-tab${viewTab === "preview" ? " oc-rules__panel-tab--active" : ""}`}
                  onClick={() => setViewTab("preview")}
                >
                  {t("commandTabPreview")}
                </button>
              </div>
              {viewTab === "editor" ? (
                <textarea
                  className="oc-rules__editor-textarea"
                  value={formContent}
                  onChange={(e) => setFormContent(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={"---\ndescription: \nagent: \nmodel: \n---\n\nYour prompt template here..."}
                  spellCheck={false}
                />
              ) : (
                (previewHtml || cmdFrontMatter) ? (
                  <div className="oc-rules__preview">
                    {cmdFrontMatter && (
                      <div className="oc-yaml-front-matter">
                        {Object.entries(cmdFrontMatter).map(([k, v]) => (
                          <div key={k} className="oc-yaml-entry">
                            <span className="oc-yaml-key">{k}</span>
                            <span className="oc-yaml-value">{v}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
                  </div>
                ) : (
                  <div className="oc-rules__preview">
                    <div className="oc-rules__preview-empty">
                      {t("commandTemplatePlaceholder")}
                    </div>
                  </div>
                )
              )}
            </div>
          </div>
          </ScopeFormWrapper>
          {displayPath && (
            <div className="oc-section__path-hint">
              {t("commandSavePath")}:{" "}
              {useRelativePaths && formScope === "project" && activeFolderPath
                ? toRelativeProjectPath(activeFolderPath, displayPath)
                : displayPath}
            </div>
          )}
          <div className="oc-section__form-actions" style={{ marginTop: 8 }}>
            <button className="oc-section__save-btn" onClick={handleSave}>{t("save")}</button>
            <button className="oc-section__cancel-btn" onClick={handleCancel}>{t("cancel")}</button>
          </div>
        </div>
      ) : (
        <>
          {scopedEntries.length === 0 && <div className="oc-section__empty">{t("commandsEmpty")}</div>}
          {scopedEntries.map(({ scope: itemScope, data: { name, cmd } }) => (
            <div key={`${itemScope}:${name}`} className={`oc-section__item oc-section__item--${itemScope}`} style={{ marginBottom: 4 }}>
              <div className="oc-section__item-info">
                <span className="oc-section__item-name">
                  {name}
                  {isBuiltinCommand(name) && (
                    <span className="oc-section__builtin-badge">Built-in</span>
                  )}
                </span>
                <span className="oc-section__item-detail">{cmd.description ?? cmd.template}</span>
              </div>
              <div className="oc-section__item-actions">
                <button className="oc-section__edit-btn" onClick={() => startEdit(name, cmd, itemScope)}>{t("edit")}</button>
                <button className="oc-section__delete-btn" onClick={() => handleDelete(name, itemScope)}>×</button>
              </div>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", marginTop: 4, position: "relative" }}>
            <button className="oc-section__add-btn" onClick={startAdd}>+ {t("add")}</button>
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
                        {name} — {REGISTRY_COMMANDS[name]?.description ?? ""}
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
