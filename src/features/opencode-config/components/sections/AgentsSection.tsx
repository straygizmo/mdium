import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useTabStore } from "@/stores/tab-store";
import { useOpencodeConfigStore, type AgentFileEntry } from "@/stores/opencode-config-store";
import type { OpencodeAgent } from "@/shared/types";
import { marked } from "marked";
import { useOpencodeConfigContext, toRelativeProjectPath } from "../OpencodeConfigContext";
import {
  BUILTIN_AGENTS,
  isBuiltinAgent,
} from "../../lib/builtin-registry";
import { ScopeToggle, type Scope } from "../shared/ScopeToggle";
import { ScopeFormWrapper } from "../shared/ScopeFormWrapper";
import { useScopeItems } from "../../hooks/useScopeItems";

type AgentViewTab = "editor" | "preview";

const EMPTY_AGENTS: Record<string, OpencodeAgent> = {};

export function AgentsSection() {
  const { t } = useTranslation("opencode-config");
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const { useRelativePaths } = useOpencodeConfigContext();
  const config = useOpencodeConfigStore((s) => s.config);
  const agents = config.agents ?? EMPTY_AGENTS;
  const saveAgent = useOpencodeConfigStore((s) => s.saveAgent);
  const deleteAgent = useOpencodeConfigStore((s) => s.deleteAgent);

  const [globalAgentFiles, setGlobalAgentFiles] = useState<AgentFileEntry[]>([]);
  const [projectAgentFiles, setProjectAgentFiles] = useState<AgentFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [displayPath, setDisplayPath] = useState("");

  const [formScope, setFormScope] = useState<Scope>("project");
  const [editingFileScope, setEditingFileScope] = useState<Scope | null>(null);

  // File-based agent editing state
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [addingFile, setAddingFile] = useState(false);
  const [fileFormName, setFileFormName] = useState("");
  const [fileFormContent, setFileFormContent] = useState("");
  const [fileSavedContent, setFileSavedContent] = useState("");
  const [fileViewTab, setFileViewTab] = useState<AgentViewTab>("editor");

  // Config-based agent editing state
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formMode, setFormMode] = useState<"all" | "primary" | "subagent">("all");
  const [formModel, setFormModel] = useState("");
  const [formPrompt, setFormPrompt] = useState("");
  const [formTemperature, setFormTemperature] = useState("");
  const [formTopP, setFormTopP] = useState("");
  const [formSteps, setFormSteps] = useState("");
  const [formTools, setFormTools] = useState("");
  const [formHidden, setFormHidden] = useState(false);
  const [formDisable, setFormDisable] = useState(false);

  const [showBuiltinMenu, setShowBuiltinMenu] = useState(false);

  // --- Scope-aware directory ---
  const getAgentsDir = useCallback(
    async (targetScope: Scope): Promise<string | null> => {
      if (targetScope === "global") {
        const home = await invoke<string>("get_home_dir");
        const sep = home.includes("\\") ? "\\" : "/";
        return `${home}${sep}.config${sep}opencode${sep}agents`;
      }
      if (activeFolderPath) {
        const sep = activeFolderPath.includes("\\") ? "\\" : "/";
        return `${activeFolderPath}${sep}.opencode${sep}agents`;
      }
      return null;
    },
    [activeFolderPath]
  );

  const loadAllAgentFiles = useCallback(async () => {
    setLoading(true);
    try {
      const globalDir = await getAgentsDir("global");
      if (globalDir) {
        const files = await invoke<AgentFileEntry[]>("list_agent_files", { agentsDir: globalDir });
        setGlobalAgentFiles(files);
      } else {
        setGlobalAgentFiles([]);
      }
      const projectDir = await getAgentsDir("project");
      if (projectDir) {
        const files = await invoke<AgentFileEntry[]>("list_agent_files", { agentsDir: projectDir });
        setProjectAgentFiles(files);
      } else {
        setProjectAgentFiles([]);
      }
    } catch {
      setGlobalAgentFiles([]);
      setProjectAgentFiles([]);
    } finally {
      setLoading(false);
    }
  }, [getAgentsDir]);

  useEffect(() => {
    loadAllAgentFiles();
  }, [loadAllAgentFiles]);

  // Derive displayPath from formScope
  useEffect(() => {
    (async () => {
      const dir = await getAgentsDir(formScope);
      if (dir) {
        setDisplayPath(`${dir}${dir.includes("\\") ? "\\" : "/"}<name>.md`);
      } else {
        setDisplayPath("");
      }
    })();
  }, [formScope, getAgentsDir]);

  // Also update global store when global agents change
  const loadGlobalAgentFiles = useOpencodeConfigStore((s) => s.loadGlobalAgentFiles);

  const allAgentFiles = [...globalAgentFiles, ...projectAgentFiles];
  const fileAgentNames = new Set(allAgentFiles.map((f) => f.agent_name));
  const missingBuiltins = Object.keys(BUILTIN_AGENTS).filter(
    (name) => !(name in agents) && !fileAgentNames.has(name)
  );
  const entries = Object.entries(agents);

  const scopedFileAgents = useScopeItems(globalAgentFiles, projectAgentFiles);

  // --- File-based agent actions ---
  const startAddFile = () => {
    setAddingFile(true);
    setFormScope("project");
    setEditingFile(null);
    setEditingFileScope(null);
    setEditing(null);
    setAdding(false);
    setFileFormName("");
    setFileFormContent("---\ndescription: \nmode: all\n---\n\n");
    setFileSavedContent("");
    setFileViewTab("editor");
  };

  const startEditFile = (entry: AgentFileEntry, entryScope: Scope) => {
    setEditingFile(entry.file_name);
    setEditingFileScope(entryScope);
    setFormScope(entryScope);
    setAddingFile(false);
    setEditing(null);
    setAdding(false);
    setFileFormName(entry.agent_name);
    setFileFormContent(entry.content);
    setFileSavedContent(entry.content);
    setFileViewTab("editor");
  };

  const handleSaveFile = async () => {
    const name = fileFormName.trim();
    if (!name) return;
    const fileName = editingFile ?? `${name}.md`;

    // If editing and scope changed, delete from old scope first
    if (editingFile && editingFileScope && editingFileScope !== formScope) {
      const oldDir = await getAgentsDir(editingFileScope);
      if (oldDir) {
        await invoke("delete_agent_file", { agentsDir: oldDir, fileName });
      }
    }

    const dir = await getAgentsDir(formScope);
    if (!dir) return;
    await invoke("write_agent_file", { agentsDir: dir, fileName, content: fileFormContent });
    setFileSavedContent(fileFormContent);
    setEditingFile(null);
    setEditingFileScope(null);
    setAddingFile(false);
    await loadAllAgentFiles();
    loadGlobalAgentFiles();
  };

  const handleDeleteFile = async (fileName: string, targetScope: Scope) => {
    const dir = await getAgentsDir(targetScope);
    if (!dir) return;
    await invoke("delete_agent_file", { agentsDir: dir, fileName });
    await loadAllAgentFiles();
    loadGlobalAgentFiles();
  };

  const handleCancelFile = () => {
    setEditingFile(null);
    setEditingFileScope(null);
    setAddingFile(false);
  };

  // --- Config-based agent actions ---

  const startEdit = (name: string, agent: OpencodeAgent) => {
    setEditing(name); setAdding(false); setEditingFile(null); setAddingFile(false);
    setFormName(name); setFormDesc(agent.description ?? ""); setFormMode(agent.mode ?? "all");
    setFormModel(agent.model ?? ""); setFormPrompt(agent.prompt ?? "");
    setFormTemperature(agent.temperature != null ? String(agent.temperature) : "");
    setFormTopP(agent.top_p != null ? String(agent.top_p) : "");
    setFormSteps(agent.steps != null ? String(agent.steps) : "");
    setFormTools(
      agent.tools ? Object.entries(agent.tools).filter(([, v]) => v).map(([k]) => k).join(", ") : ""
    );
    setFormHidden(agent.hidden ?? false); setFormDisable(agent.disable ?? false);
  };

  const handleSave = async () => {
    const name = formName.trim();
    if (!name) return;
    const agent: OpencodeAgent = {};
    if (formDesc.trim()) agent.description = formDesc.trim();
    if (formMode !== "all") agent.mode = formMode;
    if (formModel.trim()) agent.model = formModel.trim();
    if (formPrompt.trim()) agent.prompt = formPrompt.trim();
    if (formTemperature.trim()) { const v = parseFloat(formTemperature.trim()); if (!isNaN(v)) agent.temperature = v; }
    if (formTopP.trim()) { const v = parseFloat(formTopP.trim()); if (!isNaN(v)) agent.top_p = v; }
    if (formSteps.trim()) { const v = parseInt(formSteps.trim(), 10); if (!isNaN(v)) agent.steps = v; }
    if (formTools.trim()) {
      agent.tools = {};
      for (const tool of formTools.split(",").map((s) => s.trim()).filter(Boolean)) agent.tools[tool] = true;
    }
    if (formHidden) agent.hidden = true;
    if (formDisable) agent.disable = true;
    if (editing && editing !== name) await deleteAgent(editing);
    await saveAgent(name, agent);
    setEditing(null); setAdding(false);
  };

  const handleAddBuiltin = async (name: string) => {
    const entry = BUILTIN_AGENTS[name];
    if (!entry || !entry.agentMd) return;
    setFormScope("global");
    const dir = await getAgentsDir("global");
    if (!dir) return;
    await invoke("write_agent_file", { agentsDir: dir, fileName: `${name}.md`, content: entry.agentMd });
    setShowBuiltinMenu(false);
    await loadAllAgentFiles();
    loadGlobalAgentFiles();
  };

  const handleCancel = () => { setEditing(null); setAdding(false); };

  // --- Preview ---
  const previewHtml = useMemo(() => {
    if (!fileFormContent) return "";
    let body = fileFormContent;
    if (body.startsWith("---\n") || body.startsWith("---\r\n")) {
      const endIdx = body.indexOf("\n---", 4);
      if (endIdx !== -1) {
        const afterFm = body.indexOf("\n", endIdx + 4);
        body = afterFm !== -1 ? body.substring(afterFm + 1) : "";
      }
    }
    try { return marked(body, { async: false, gfm: true, breaks: true }) as string; }
    catch { return "<p>Markdown rendering error</p>"; }
  }, [fileFormContent]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const ta = e.currentTarget;
        const s = ta.selectionStart, en = ta.selectionEnd;
        const nc = fileFormContent.substring(0, s) + "  " + fileFormContent.substring(en);
        setFileFormContent(nc);
        setTimeout(() => { ta.selectionStart = ta.selectionEnd = s + 2; }, 0);
      }
    },
    [fileFormContent]
  );

  const isEditingConfig = adding || editing !== null;
  const isEditingFile = addingFile || editingFile !== null;
  const isEditing = isEditingConfig || isEditingFile;
  const fileDirty = fileFormContent !== fileSavedContent || addingFile;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className="oc-section__hint">
        {t("agentsDescription")}
        {" "}
        <a
          href="#"
          onClick={(e) => { e.preventDefault(); invoke("open_external_url", { url: t("agentsDocsUrl") }); }}
          style={{ textDecoration: "none", cursor: "pointer" }}
          title={t("agentsDocsUrl")}
        >
          🔗
        </a>
      </div>

      {loading && <div className="oc-section__empty">...</div>}

      {/* File-based agent MD editor */}
      {!loading && isEditingFile && (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <ScopeToggle value={formScope} onChange={setFormScope} />
          <ScopeFormWrapper scope={formScope}>
            <div className="oc-section__field">
              <label className="oc-section__label">{t("agentName")}</label>
              <input
                className="oc-section__input"
                value={fileFormName}
                onChange={(e) => setFileFormName(e.target.value)}
                disabled={editingFile !== null}
                placeholder="e.g. rag"
              />
            </div>
            <div className="oc-section__field" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
              <label className="oc-section__label">Content (YAML frontmatter + Markdown prompt)</label>
              <div className="oc-rules__editor-panel">
                <div className="oc-rules__panel-tabs">
                  <button
                    className={`oc-rules__panel-tab${fileViewTab === "editor" ? " oc-rules__panel-tab--active" : ""}`}
                    onClick={() => setFileViewTab("editor")}
                  >{t("skillTabEditor")}</button>
                  <button
                    className={`oc-rules__panel-tab${fileViewTab === "preview" ? " oc-rules__panel-tab--active" : ""}`}
                    onClick={() => setFileViewTab("preview")}
                  >{t("skillTabPreview")}</button>
                </div>
                {fileViewTab === "editor" ? (
                  <textarea
                    className="oc-rules__editor-textarea"
                    value={fileFormContent}
                    onChange={(e) => setFileFormContent(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={"---\ndescription: My agent\nmode: all\n---\n\nYour system prompt here..."}
                    spellCheck={false}
                  />
                ) : previewHtml ? (
                  <div className="oc-rules__preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
                ) : (
                  <div className="oc-rules__preview"><div className="oc-rules__preview-empty">No content</div></div>
                )}
              </div>
            </div>
          </ScopeFormWrapper>
          {displayPath && (
            <div className="oc-section__path-hint">
              {t("agentSavePath")}:{" "}
              {useRelativePaths && formScope === "project" && activeFolderPath
                ? toRelativeProjectPath(activeFolderPath, displayPath)
                : displayPath}
            </div>
          )}
          <div className="oc-section__form-actions" style={{ marginTop: 8, flexShrink: 0 }}>
            <button
              className="oc-section__save-btn"
              onClick={handleSaveFile}
              disabled={!(editingFile ?? fileFormName).trim() || (!fileDirty && editingFile !== null)}
              style={{ opacity: (editingFile ?? fileFormName).trim() && (fileDirty || editingFile === null) ? 1 : 0.5 }}
            >{t("save")}</button>
            <button className="oc-section__cancel-btn" onClick={handleCancelFile}>{t("cancel")}</button>
          </div>
        </div>
      )}

      {/* Config-based agent form (global scope only, for opencode.jsonc agents) */}
      {!loading && isEditingConfig && (
        <>
          <div className="oc-section__field">
            <label className="oc-section__label">{t("agentName")}</label>
            <input className="oc-section__input" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. build" disabled={editing !== null} />
          </div>
          <div className="oc-section__field">
            <label className="oc-section__label">{t("agentDescription")}</label>
            <input className="oc-section__input" value={formDesc} onChange={(e) => setFormDesc(e.target.value)} placeholder="e.g. Build and deploy agent" />
          </div>
          <div className="oc-section__field">
            <label className="oc-section__label">{t("agentPrompt")}</label>
            <textarea className="oc-section__textarea" value={formPrompt} onChange={(e) => setFormPrompt(e.target.value)} placeholder="System prompt or {file:./prompts/agent.txt}" spellCheck={false} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
            <div className="oc-section__field">
              <label className="oc-section__label">{t("agentMode")}</label>
              <select className="oc-section__input" value={formMode} onChange={(e) => setFormMode(e.target.value as any)}>
                <option value="all">{t("agentModeAll")}</option>
                <option value="primary">{t("agentModePrimary")}</option>
                <option value="subagent">{t("agentModeSubagent")}</option>
              </select>
            </div>
            <div className="oc-section__field">
              <label className="oc-section__label">{t("agentSteps")}</label>
              <input className="oc-section__input" type="number" min="1" value={formSteps} onChange={(e) => setFormSteps(e.target.value)} placeholder="e.g. 50" />
            </div>
            <div className="oc-section__field">
              <label className="oc-section__label">{t("agentModel")}</label>
              <input className="oc-section__input" value={formModel} onChange={(e) => setFormModel(e.target.value)} placeholder="e.g. anthropic/claude-sonnet-4-20250514" />
            </div>
            <div className="oc-section__field">
              <label className="oc-section__label">{t("agentTemperature")}</label>
              <input className="oc-section__input" type="number" min="0" max="1" step="0.1" value={formTemperature} onChange={(e) => setFormTemperature(e.target.value)} placeholder="0.0 - 1.0" />
            </div>
            <div className="oc-section__field">
              <label className="oc-section__label">{t("agentTopP")}</label>
              <input className="oc-section__input" type="number" min="0" max="1" step="0.1" value={formTopP} onChange={(e) => setFormTopP(e.target.value)} placeholder="0.0 - 1.0" />
            </div>
            <div className="oc-section__field">
              <label className="oc-section__label">{t("agentToolsList")}</label>
              <input className="oc-section__input" value={formTools} onChange={(e) => setFormTools(e.target.value)} placeholder="e.g. write, bash, edit, read" />
            </div>
          </div>
          <label className="oc-section__toggle oc-section__toggle--inline">
            <input type="checkbox" checked={formHidden} onChange={(e) => setFormHidden(e.target.checked)} />
            {t("agentHidden")}
          </label>
          <label className="oc-section__toggle oc-section__toggle--inline">
            <input type="checkbox" checked={!formDisable} onChange={(e) => setFormDisable(!e.target.checked)} />
            {t("agentEnabled")}
          </label>
          <div className="oc-section__form-actions" style={{ marginTop: 8 }}>
            <button className="oc-section__save-btn" onClick={handleSave}>{t("save")}</button>
            <button className="oc-section__cancel-btn" onClick={handleCancel}>{t("cancel")}</button>
          </div>
        </>
      )}

      {/* Agent list */}
      {!loading && !isEditing && (
        <>
          {scopedFileAgents.length === 0 && entries.length === 0 && (
            <div className="oc-section__empty">{t("agentsEmpty")}</div>
          )}
          {/* File-based agents */}
          {scopedFileAgents.map(({ scope: itemScope, data: entry }) => (
            <div
              key={`${itemScope}-${entry.file_name}`}
              className={`oc-section__item oc-section__item--${itemScope}`}
              style={{ marginBottom: 4 }}
            >
              <div className="oc-section__item-info">
                <span className="oc-section__item-name">
                  {entry.agent_name}
                  {isBuiltinAgent(entry.agent_name) && (
                    <span className="oc-section__builtin-badge">Built-in</span>
                  )}
                </span>
                <span className="oc-section__item-detail">{entry.description}</span>
              </div>
              <div className="oc-section__item-actions">
                <button className="oc-section__edit-btn" onClick={() => startEditFile(entry, itemScope)}>{t("edit")}</button>
                <button className="oc-section__delete-btn" onClick={() => handleDeleteFile(entry.file_name, itemScope)}>×</button>
              </div>
            </div>
          ))}
          {/* Config-based agents (global only) */}
          {entries.map(([name, agent]) => (
            <div key={name} className={`oc-section__item oc-section__item--global`} style={{ marginBottom: 4 }}>
              <div className="oc-section__item-info">
                <span className="oc-section__item-name">{name}</span>
                <span className="oc-section__item-detail">{agent.description ?? agent.model ?? ""}</span>
              </div>
              <div className="oc-section__item-actions">
                <button className="oc-section__edit-btn" onClick={() => startEdit(name, agent)}>{t("edit")}</button>
                <button className="oc-section__delete-btn" onClick={() => deleteAgent(name)}>×</button>
              </div>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", marginTop: 4, position: "relative" }}>
            <button className="oc-section__add-btn" onClick={startAddFile}>+ {t("add")}</button>
            {missingBuiltins.length > 0 && (
              <>
                <button className="oc-section__builtin-btn" onClick={() => setShowBuiltinMenu((v) => !v)}>
                  + Built-in
                </button>
                {showBuiltinMenu && (
                  <div className="oc-section__builtin-dropdown">
                    {missingBuiltins.map((name) => (
                      <button key={name} className="oc-section__builtin-dropdown-item" onClick={() => handleAddBuiltin(name)}>
                        {name} — {BUILTIN_AGENTS[name].description ?? ""}
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
