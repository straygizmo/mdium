import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useOpencodeConfigStore } from "@/stores/opencode-config-store";
import type { OpencodeAgent } from "@/shared/types";
import {
  BUILTIN_AGENTS,
  isBuiltinAgent,
} from "../../lib/builtin-registry";

const EMPTY_AGENTS: Record<string, OpencodeAgent> = {};

export function AgentsSection() {
  const { t } = useTranslation("opencode-config");
  const config = useOpencodeConfigStore((s) => s.config);
  const agents = config.agents ?? EMPTY_AGENTS;
  const saveAgent = useOpencodeConfigStore((s) => s.saveAgent);
  const deleteAgent = useOpencodeConfigStore((s) => s.deleteAgent);
  const globalAgentFiles = useOpencodeConfigStore((s) => s.globalAgentFiles);
  const loadGlobalAgentFiles = useOpencodeConfigStore((s) => s.loadGlobalAgentFiles);
  const writeAgentFile = useOpencodeConfigStore((s) => s.writeAgentFile);
  const deleteAgentFile = useOpencodeConfigStore((s) => s.deleteAgentFile);

  useEffect(() => {
    loadGlobalAgentFiles();
  }, [loadGlobalAgentFiles]);

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

  const entries = Object.entries(agents);
  // Builtin agents are "missing" if not in config AND not in agent files
  const fileAgentNames = new Set(globalAgentFiles.map((f) => f.agent_name));
  const missingBuiltins = Object.keys(BUILTIN_AGENTS).filter(
    (name) => !(name in agents) && !fileAgentNames.has(name)
  );

  const resetForm = () => {
    setFormName("");
    setFormDesc("");
    setFormMode("all");
    setFormModel("");
    setFormPrompt("");
    setFormTemperature("");
    setFormTopP("");
    setFormSteps("");
    setFormTools("");
    setFormHidden(false);
    setFormDisable(false);
  };

  const startAdd = () => {
    setAdding(true);
    setEditing(null);
    resetForm();
  };

  const startEdit = (name: string, agent: OpencodeAgent) => {
    setEditing(name);
    setAdding(false);
    setFormName(name);
    setFormDesc(agent.description ?? "");
    setFormMode(agent.mode ?? "all");
    setFormModel(agent.model ?? "");
    setFormPrompt(agent.prompt ?? "");
    setFormTemperature(agent.temperature != null ? String(agent.temperature) : "");
    setFormTopP(agent.top_p != null ? String(agent.top_p) : "");
    setFormSteps(agent.steps != null ? String(agent.steps) : "");
    setFormTools(
      agent.tools
        ? Object.entries(agent.tools)
            .filter(([, v]) => v)
            .map(([k]) => k)
            .join(", ")
        : ""
    );
    setFormHidden(agent.hidden ?? false);
    setFormDisable(agent.disable ?? false);
  };

  const handleSave = async () => {
    const name = formName.trim();
    if (!name) return;

    const agent: OpencodeAgent = {};
    if (formDesc.trim()) agent.description = formDesc.trim();
    if (formMode !== "all") agent.mode = formMode;
    if (formModel.trim()) agent.model = formModel.trim();
    if (formPrompt.trim()) agent.prompt = formPrompt.trim();
    if (formTemperature.trim()) {
      const v = parseFloat(formTemperature.trim());
      if (!isNaN(v)) agent.temperature = v;
    }
    if (formTopP.trim()) {
      const v = parseFloat(formTopP.trim());
      if (!isNaN(v)) agent.top_p = v;
    }
    if (formSteps.trim()) {
      const v = parseInt(formSteps.trim(), 10);
      if (!isNaN(v)) agent.steps = v;
    }
    if (formTools.trim()) {
      agent.tools = {};
      for (const tool of formTools.split(",").map((s) => s.trim()).filter(Boolean)) {
        agent.tools[tool] = true;
      }
    }
    if (formHidden) agent.hidden = true;
    if (formDisable) agent.disable = true;

    if (editing && editing !== name) {
      await deleteAgent(editing);
    }

    await saveAgent(name, agent);
    setEditing(null);
    setAdding(false);
  };

  const handleAddBuiltin = async (name: string) => {
    const entry = BUILTIN_AGENTS[name];
    if (!entry || !entry.agentMd) return;
    await writeAgentFile(name, entry.agentMd);
    setShowBuiltinMenu(false);
  };

  const handleCancel = () => {
    setEditing(null);
    setAdding(false);
  };

  const isEditing = adding || editing !== null;

  return (
    <div>
      <div className="oc-section__hint">
        {t("agentsDescription")}
        {" "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            invoke("open_external_url", { url: t("agentsDocsUrl") });
          }}
          style={{ textDecoration: "none", cursor: "pointer" }}
          title={t("agentsDocsUrl")}
        >
          🔗
        </a>
      </div>

      {isEditing ? (
        <>
          <div className="oc-section__field">
            <label className="oc-section__label">{t("agentName")}</label>
            <input
              className="oc-section__input"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="e.g. build"
              disabled={editing !== null}
            />
          </div>
          <div className="oc-section__field">
            <label className="oc-section__label">{t("agentDescription")}</label>
            <input
              className="oc-section__input"
              value={formDesc}
              onChange={(e) => setFormDesc(e.target.value)}
              placeholder="e.g. Build and deploy agent"
            />
          </div>
          <div className="oc-section__field">
            <label className="oc-section__label">{t("agentPrompt")}</label>
            <textarea
              className="oc-section__textarea"
              value={formPrompt}
              onChange={(e) => setFormPrompt(e.target.value)}
              placeholder="System prompt or {file:./prompts/agent.txt}"
              spellCheck={false}
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
            <div className="oc-section__field">
              <label className="oc-section__label">{t("agentMode")}</label>
              <select
                className="oc-section__input"
                value={formMode}
                onChange={(e) => setFormMode(e.target.value as "all" | "primary" | "subagent")}
              >
                <option value="all">{t("agentModeAll")}</option>
                <option value="primary">{t("agentModePrimary")}</option>
                <option value="subagent">{t("agentModeSubagent")}</option>
              </select>
            </div>
            <div className="oc-section__field">
              <label className="oc-section__label">{t("agentSteps")}</label>
              <input
                className="oc-section__input"
                type="number"
                min="1"
                value={formSteps}
                onChange={(e) => setFormSteps(e.target.value)}
                placeholder="e.g. 50"
              />
            </div>
            <div className="oc-section__field">
              <label className="oc-section__label">{t("agentModel")}</label>
              <input
                className="oc-section__input"
                value={formModel}
                onChange={(e) => setFormModel(e.target.value)}
                placeholder="e.g. anthropic/claude-sonnet-4-20250514"
              />
            </div>
            <div className="oc-section__field">
              <label className="oc-section__label">{t("agentTemperature")}</label>
              <input
                className="oc-section__input"
                type="number"
                min="0"
                max="1"
                step="0.1"
                value={formTemperature}
                onChange={(e) => setFormTemperature(e.target.value)}
                placeholder="0.0 - 1.0"
              />
            </div>
            <div className="oc-section__field">
              <label className="oc-section__label">{t("agentTopP")}</label>
              <input
                className="oc-section__input"
                type="number"
                min="0"
                max="1"
                step="0.1"
                value={formTopP}
                onChange={(e) => setFormTopP(e.target.value)}
                placeholder="0.0 - 1.0"
              />
            </div>
            <div className="oc-section__field">
              <label className="oc-section__label">{t("agentToolsList")}</label>
              <input
                className="oc-section__input"
                value={formTools}
                onChange={(e) => setFormTools(e.target.value)}
                placeholder="e.g. write, bash, edit, read"
              />
            </div>
          </div>
          <label className="oc-section__toggle oc-section__toggle--inline">
            <input
              type="checkbox"
              checked={formHidden}
              onChange={(e) => setFormHidden(e.target.checked)}
            />
            {t("agentHidden")}
          </label>
          <label className="oc-section__toggle oc-section__toggle--inline">
            <input
              type="checkbox"
              checked={!formDisable}
              onChange={(e) => setFormDisable(!e.target.checked)}
            />
            {t("agentEnabled")}
          </label>
          <div className="oc-section__form-actions" style={{ marginTop: 8 }}>
            <button className="oc-section__save-btn" onClick={handleSave}>{t("save")}</button>
            <button className="oc-section__cancel-btn" onClick={handleCancel}>{t("cancel")}</button>
          </div>
        </>
      ) : (
        <>
          {entries.length === 0 && globalAgentFiles.length === 0 && <div className="oc-section__empty">{t("agentsEmpty")}</div>}
          {/* File-based agents (from ~/.config/opencode/agents/*.md) */}
          {globalAgentFiles.map((af) => (
            <div key={`file:${af.agent_name}`} className="oc-section__item" style={{ marginBottom: 4 }}>
              <div className="oc-section__item-info">
                <span className="oc-section__item-name">
                  {af.agent_name}
                  {isBuiltinAgent(af.agent_name) && (
                    <span className="oc-section__builtin-badge">Built-in</span>
                  )}
                </span>
                <span className="oc-section__item-detail">{af.description}</span>
              </div>
              <div className="oc-section__item-actions">
                <button className="oc-section__delete-btn" onClick={() => deleteAgentFile(af.agent_name)}>×</button>
              </div>
            </div>
          ))}
          {/* Config-based agents (from opencode.jsonc) */}
          {entries.map(([name, agent]) => (
            <div key={name} className="oc-section__item" style={{ marginBottom: 4 }}>
              <div className="oc-section__item-info">
                <span className="oc-section__item-name">
                  {name}
                </span>
                <span className="oc-section__item-detail">{agent.description ?? agent.model ?? ""}</span>
              </div>
              <div className="oc-section__item-actions">
                <button className="oc-section__edit-btn" onClick={() => startEdit(name, agent)}>{t("edit")}</button>
                <button className="oc-section__delete-btn" onClick={() => deleteAgent(name)}>×</button>
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
