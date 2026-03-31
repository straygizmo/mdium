import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { useOpencodeConfigStore } from "@/stores/opencode-config-store";
import { useTabStore } from "@/stores/tab-store";
import type { OpencodeCommand } from "@/shared/types";
import { useOpencodeConfigContext, toRelativeProjectPath } from "../OpencodeConfigContext";
import { BUILTIN_COMMANDS } from "../../lib/builtin-commands";
import { marked } from "marked";

type Scope = "global" | "project";
type ViewTab = "editor" | "preview";

const EMPTY_COMMANDS: Record<string, OpencodeCommand> = {};

export function CommandsSection() {
  const { t } = useTranslation("opencode-config");
  const config = useOpencodeConfigStore((s) => s.config);
  const projectCommands = useOpencodeConfigStore((s) => s.projectCommands);
  const saveCommand = useOpencodeConfigStore((s) => s.saveCommand);
  const deleteCommand = useOpencodeConfigStore((s) => s.deleteCommand);
  const loadProjectCommands = useOpencodeConfigStore((s) => s.loadProjectCommands);
  const saveProjectCommand = useOpencodeConfigStore((s) => s.saveProjectCommand);
  const deleteProjectCommand = useOpencodeConfigStore((s) => s.deleteProjectCommand);
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const { useRelativePaths } = useOpencodeConfigContext();

  const [scope, setScope] = useState<Scope>("global");
  const [globalConfigPath, setGlobalConfigPath] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formTemplate, setFormTemplate] = useState("");
  const [formAgent, setFormAgent] = useState("");
  const [formModel, setFormModel] = useState("");
  const [viewTab, setViewTab] = useState<ViewTab>("editor");

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

  useEffect(() => {
    if (scope === "project" && activeFolderPath) {
      loadProjectCommands(activeFolderPath);
    }
  }, [scope, activeFolderPath, loadProjectCommands]);

  const globalCommands = config.command ?? EMPTY_COMMANDS;
  const commands = scope === "global" ? globalCommands : projectCommands;
  const entries = Object.entries(commands);

  const startEdit = (name: string, cmd: OpencodeCommand) => {
    setEditing(name);
    setFormName(name);
    setFormDesc(cmd.description ?? "");
    setFormTemplate(cmd.template);
    setFormAgent(cmd.agent ?? "");
    setFormModel(cmd.model ?? "");
    setViewTab("editor");
  };

  const startAdd = () => {
    setAdding(true);
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
    const cmd: OpencodeCommand = {
      template: formTemplate.trim(),
      description: formDesc.trim() || undefined,
      agent: formAgent.trim() || undefined,
      model: formModel.trim() || undefined,
    };
    if (scope === "global") {
      await saveCommand(name, cmd);
    } else if (activeFolderPath) {
      await saveProjectCommand(activeFolderPath, name, cmd);
    }
    setEditing(null);
    setAdding(false);
  };

  const handleDelete = async (name: string) => {
    const confirmed = await ask(t("commandDeleteConfirm", { name }), { kind: "warning" });
    if (!confirmed) return;
    if (scope === "global") {
      await deleteCommand(name);
    } else if (activeFolderPath) {
      await deleteProjectCommand(activeFolderPath, name);
    }
  };

  const handleCancel = () => {
    setEditing(null);
    setAdding(false);
  };

  const handleScopeChange = (newScope: Scope) => {
    setScope(newScope);
    setEditing(null);
    setAdding(false);
  };

  const isEditing = adding || editing !== null;

  const savePath = scope === "global"
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

      <div className="oc-section__scope-tabs">
        <button
          className={`oc-section__scope-tab${scope === "global" ? " oc-section__scope-tab--active" : ""}`}
          onClick={() => handleScopeChange("global")}
        >
          {t("commandScopeGlobal")}
        </button>
        <button
          className={`oc-section__scope-tab${scope === "project" ? " oc-section__scope-tab--active" : ""}`}
          onClick={() => handleScopeChange("project")}
        >
          {t("commandScopeProject")}
        </button>
      </div>

      {savePath && (
        <div className="oc-section__path-hint">
          {t("commandSavePath")}:{" "}
          {useRelativePaths && scope === "project" && activeFolderPath
            ? toRelativeProjectPath(activeFolderPath, savePath)
            : savePath}
        </div>
      )}

      {scope === "project" && !activeFolderPath ? (
        <div className="oc-section__empty">{t("commandNoProject")}</div>
      ) : isEditing ? (
        <>
          {/* Built-In Command selector */}
          <div style={{ marginBottom: 8 }}>
            <select
              className="oc-section__builtin-select"
              value=""
              onChange={(e) => {
                const key = e.target.value;
                if (!key) return;
                const builtin = BUILTIN_COMMANDS[key];
                if (!builtin) return;
                setFormName(builtin.name);
                setFormDesc(builtin.description ?? "");
                setFormTemplate(builtin.template);
                setFormAgent(builtin.agent ?? "");
                setFormModel(builtin.model ?? "");
              }}
            >
              <option value="">{t("commandBuiltinSelect")}</option>
              {Object.keys(BUILTIN_COMMANDS).map((key) => (
                <option key={key} value={key}>{key}</option>
              ))}
            </select>
          </div>
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
          <div className="oc-section__form-actions" style={{ marginTop: 8 }}>
            <button className="oc-section__save-btn" onClick={handleSave}>{t("save")}</button>
            <button className="oc-section__cancel-btn" onClick={handleCancel}>{t("cancel")}</button>
          </div>
        </>
      ) : (
        <>
          {entries.length === 0 && <div className="oc-section__empty">{t("commandsEmpty")}</div>}
          {entries.map(([name, cmd]) => (
            <div key={name} className="oc-section__item" style={{ marginBottom: 4 }}>
              <div className="oc-section__item-info">
                <span className="oc-section__item-name">{name}</span>
                <span className="oc-section__item-detail">{cmd.description ?? cmd.template}</span>
              </div>
              <div className="oc-section__item-actions">
                <button className="oc-section__edit-btn" onClick={() => startEdit(name, cmd)}>{t("edit")}</button>
                <button className="oc-section__delete-btn" onClick={() => handleDelete(name)}>×</button>
              </div>
            </div>
          ))}
          <button className="oc-section__add-btn" onClick={startAdd} style={{ marginTop: 4 }}>+ {t("add")}</button>
        </>
      )}
    </div>
  );
}
