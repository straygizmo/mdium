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
  const [formDesc, setFormDesc] = useState("");
  const [formTemplate, setFormTemplate] = useState("");
  const [formAgent, setFormAgent] = useState("");
  const [formModel, setFormModel] = useState("");
  const [viewTab, setViewTab] = useState<ViewTab>("editor");
  const [showBuiltinMenu, setShowBuiltinMenu] = useState(false);

  const previewHtml = useMemo(() => {
    if (!formTemplate) return "";
    try {
      return marked(formTemplate, { async: false, gfm: true, breaks: true }) as string;
    } catch {
      return "<p>Markdown rendering error</p>";
    }
  }, [formTemplate]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const textarea = e.currentTarget;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const newContent =
          formTemplate.substring(0, start) + "  " + formTemplate.substring(end);
        setFormTemplate(newContent);
        setTimeout(() => {
          textarea.selectionStart = textarea.selectionEnd = start + 2;
        }, 0);
      }
    },
    [formTemplate]
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

  const startEdit = (name: string, cmd: OpencodeCommand, itemScope: Scope) => {
    setEditing(name);
    setEditingScope(itemScope);
    setFormScope(itemScope);
    setFormName(name);
    setFormDesc(cmd.description ?? "");
    setFormTemplate(cmd.template);
    setFormAgent(cmd.agent ?? "");
    setFormModel(cmd.model ?? "");
    setViewTab("editor");
  };

  const startAdd = () => {
    setAdding(true);
    setFormScope("project");
    setEditingScope(null);
    setFormName("");
    setFormDesc("");
    setFormTemplate("");
    setFormAgent("");
    setFormModel("");
    setViewTab("editor");
  };

  const handleSave = async () => {
    const name = formName.trim();
    if (!name || !formTemplate.trim()) return;
    const cmdObj: OpencodeCommand = {
      template: formTemplate.trim(),
      description: formDesc.trim() || undefined,
      agent: formAgent.trim() || undefined,
      model: formModel.trim() || undefined,
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
    <div>
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
          <div className="oc-section__field">
            <label className="oc-section__label">{t("commandDescription")} <span className="oc-section__label-hint">{t("commandDescriptionHint")}</span></label>
            <input className="oc-section__input" value={formDesc} onChange={(e) => setFormDesc(e.target.value)} />
          </div>
          <div className="oc-section__field">
            <label className="oc-section__label">{t("commandTemplate")} <span className="oc-section__label-hint">{t("commandTemplateHint")}</span></label>
            <div className="oc-rules__editor-panel" style={{ minHeight: 180 }}>
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
                  style={{ minHeight: 180 }}
                  value={formTemplate}
                  onChange={(e) => setFormTemplate(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={t("commandTemplatePlaceholder")}
                  spellCheck={false}
                />
              ) : (
                formTemplate ? (
                  <div
                    className="oc-rules__preview"
                    style={{ minHeight: 180 }}
                    dangerouslySetInnerHTML={{ __html: previewHtml }}
                  />
                ) : (
                  <div className="oc-rules__preview" style={{ minHeight: 180 }}>
                    <div className="oc-rules__preview-empty">
                      {t("commandTemplatePlaceholder")}
                    </div>
                  </div>
                )
              )}
            </div>
          </div>
          <div className="oc-section__field">
            <label className="oc-section__label">{t("commandAgent")} <span className="oc-section__label-hint">{t("commandAgentHint")}</span></label>
            <input className="oc-section__input" value={formAgent} onChange={(e) => setFormAgent(e.target.value)} />
          </div>
          <div className="oc-section__field">
            <label className="oc-section__label">{t("commandModel")} <span className="oc-section__label-hint">{t("commandModelHint")}</span></label>
            <input className="oc-section__input" value={formModel} onChange={(e) => setFormModel(e.target.value)} />
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
