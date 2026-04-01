import { useState, useCallback, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, message, open } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "@/stores/settings-store";
import type { SpeechModel } from "@/stores/settings-store";
import type { AiSettings } from "@/shared/types";
import { useTabStore } from "@/stores/tab-store";
import { ThemeSelector } from "./ThemeSelector";
import { LanguageSelector } from "./LanguageSelector";

import "./SettingsDialog.css";

const PROVIDERS = [
  { id: "anthropic", label: "Claude / Anthropic",     format: "anthropic" as const, baseUrl: "https://api.anthropic.com/v1",                             model: "claude-haiku-4-5" },
  { id: "azure",     label: "Azure OpenAI",           format: "azure" as const,     baseUrl: "",                                                                    model: "gpt-5.1" },
  { id: "deepseek",  label: "DeepSeek",             format: "openai" as const,    baseUrl: "https://api.deepseek.com/v1",                              model: "deepseek-chat" },
  { id: "gemini",    label: "Gemini / Google",        format: "openai" as const,    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",  model: "gemini-2.5-flash" },
  { id: "grok",      label: "Grok / xAI",            format: "openai" as const,    baseUrl: "https://api.x.ai/v1",                                      model: "grok-4-1-fast-reasoning" },
  { id: "groq",      label: "Groq",                  format: "openai" as const,    baseUrl: "https://api.groq.com/openai/v1",                           model: "llama-3.3-70b-versatile" },
  { id: "ollama",    label: "Ollama",                  format: "openai" as const,    baseUrl: "http://localhost:11434/v1",                                 model: "llama3.2" },
  { id: "openai",    label: "OpenAI (ChatGPT)",       format: "openai" as const,    baseUrl: "https://api.openai.com/v1",                                model: "gpt-5.1" },
  { id: "custom",    label: "Custom",                 format: "openai" as const,    baseUrl: "",                                                         model: "" },
];

interface SettingsDialogProps {
  filterVisibility?: {
    showDocx: boolean;
    showXls: boolean;
    showKm: boolean;
    showImages: boolean;
    showPdf: boolean;
  };
  onSaveFilterVisibility?: (v: {
    showDocx: boolean;
    showXls: boolean;
    showKm: boolean;
    showImages: boolean;
    showPdf: boolean;
  }) => void;
}

const DEFAULT_VISIBILITY = {
  showDocx: true,
  showXls: true,
  showKm: false,
  showImages: false,
  showPdf: false,
};

export function SettingsDialog({ filterVisibility, onSaveFilterVisibility }: SettingsDialogProps) {
  const { t } = useTranslation("settings");
  const {
    showSettings, setShowSettings,
    autoSave, setAutoSave,
    restoreLastFolders, setRestoreLastFolders,
    aiSettings, setAiSettings,
    addVerifiedModel,
    speechEnabled, setSpeechEnabled,
    speechModel, setSpeechModel,
    language,
  } = useSettingsStore();

  const [activeTab, setActiveTab] = useState<"general" | "ai" | "display" | "other">("general");

  // --- Local state (deferred until Save) ---
  const [localAutoSave, setLocalAutoSave] = useState(autoSave);
  const [localRestoreLastFolders, setLocalRestoreLastFolders] = useState(restoreLastFolders);
  const [localSpeechEnabled, setLocalSpeechEnabled] = useState(speechEnabled);
  const [localSpeechModel, setLocalSpeechModel] = useState<SpeechModel>(speechModel);
  const [localAi, setLocalAi] = useState<AiSettings>(aiSettings);
  const [localVisibility, setLocalVisibility] = useState(filterVisibility ?? DEFAULT_VISIBILITY);

  const [localMedium, setLocalMedium] = useState(
    useSettingsStore.getState().mediumSettings
  );
  const [mediumTestStatus, setMediumTestStatus] = useState<
    "idle" | "testing" | "success" | "error"
  >("idle");
  const [mediumUsername, setMediumUsername] = useState("");

  const handleMediumTest = async () => {
    if (!localMedium.apiToken) return;
    setMediumTestStatus("testing");
    try {
      const result = await invoke<string>("medium_test_connection", {
        token: localMedium.apiToken,
      });
      const parsed = JSON.parse(result);
      setMediumUsername(parsed.username);
      setMediumTestStatus("success");
    } catch {
      setMediumTestStatus("error");
    }
  };

  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [manualModelInput, setManualModelInput] = useState(false);

  // Reset local state when dialog opens
  useEffect(() => {
    if (showSettings) {
      setLocalAutoSave(autoSave);
      setLocalRestoreLastFolders(restoreLastFolders);
      setLocalSpeechEnabled(speechEnabled);
      setLocalSpeechModel(speechModel);
      setLocalAi(aiSettings);
      setLocalVisibility(filterVisibility ?? DEFAULT_VISIBILITY);
      setTestMsg(null);
      setManualModelInput(false);
    }
  }, [showSettings]);

  // Build model dropdown options for current provider
  const modelOptions = useMemo(() => {
    const provider = PROVIDERS.find((p) => p.id === localAi.provider);
    const defaultModel = provider?.model;
    const verified = localAi.verifiedModels?.[localAi.provider] ?? [];
    const set = new Set<string>();
    if (defaultModel) set.add(defaultModel);
    for (const m of verified) set.add(m);
    return Array.from(set);
  }, [localAi.provider, localAi.verifiedModels]);

  // Speech model state
  const [speechModelReady, setSpeechModelReady] = useState<Record<string, boolean>>({});
  const [speechDownloading, setSpeechDownloading] = useState(false);
  const [speechDownloadProgress, setSpeechDownloadProgress] = useState(0);

  useEffect(() => {
    if (!showSettings) return;
    const checkModels = async () => {
      const models: SpeechModel[] = [
        "Xenova/whisper-small",
        "onnx-community/whisper-large-v3-turbo",
        ...(language === "en" ? ["onnx-community/moonshine-base-ONNX" as SpeechModel] : []),
      ];
      const result: Record<string, boolean> = {};
      for (const m of models) {
        try {
          result[m] = await invoke<boolean>("speech_check_model", { modelName: m });
        } catch {
          result[m] = false;
        }
      }
      setSpeechModelReady(result);
    };
    checkModels();
  }, [showSettings]);

  const handleSpeechDownload = useCallback(async () => {
    setSpeechDownloading(true);
    setSpeechDownloadProgress(0);

    const unlisten = await listen<{ downloaded: number; total: number; file_index: number; file_count: number }>(
      "speech-model-download-progress",
      (event) => {
        const { downloaded, total, file_index, file_count } = event.payload;
        const fileProgress = total > 0 ? downloaded / total : 0;
        const overall = ((file_index + fileProgress) / file_count) * 100;
        setSpeechDownloadProgress(Math.round(overall));
      }
    );

    try {
      await invoke("speech_download_model", { modelName: localSpeechModel });
      setSpeechModelReady((prev) => ({ ...prev, [localSpeechModel]: true }));
    } catch (e) {
      console.error("Speech model download failed:", e);
    } finally {
      unlisten();
      setSpeechDownloading(false);
    }
  }, [localSpeechModel]);

  // --- Zenn initialization handler ---
  const handleZennInit = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return;
    const folderPath = selected as string;

    // Check if folder is empty
    try {
      const entries = await invoke<Array<unknown>>("get_file_tree", {
        dirPath: folderPath,
        showAll: true,
        includeDocx: false,
        includeXls: false,
        includeKm: false,
        includeImages: false,
        includePdf: false,
        includeEmptyDirs: false,
      });
      if (entries.length > 0) {
        await message(t("zennInitNotEmpty"), { kind: "warning" });
        return;
      }
    } catch {
      // If get_file_tree fails, try to proceed
    }

    try {
      await invoke("git_init", { path: folderPath });
      await invoke("create_folder", { path: `${folderPath}/articles` });
      await invoke("create_folder", { path: `${folderPath}/books` });
      await invoke("create_folder", { path: `${folderPath}/images` });
      await invoke("create_folder", { path: `${folderPath}/work` });
      await invoke("write_text_file", {
        path: `${folderPath}/.gitignore`,
        content: "work/\n",
      });
      await message(t("zennInitSuccess"), { kind: "info" });
      setShowSettings(false);

      // Open the initialized folder as a workspace
      useTabStore.getState().openFolder(folderPath);
    } catch (e) {
      await message(`${t("zennInitFailed")}: ${e}`, { kind: "error" });
    }
  }, [t, setShowSettings]);

  // --- Save / Cancel ---
  const handleSave = async () => {
    setAutoSave(localAutoSave);
    setRestoreLastFolders(localRestoreLastFolders);
    setSpeechEnabled(localSpeechEnabled);
    setSpeechModel(localSpeechModel);
    setAiSettings(localAi);
    useSettingsStore.getState().setMediumSettings(localMedium);
    onSaveFilterVisibility?.(localVisibility);
    setShowSettings(false);

    // Azure only: check AZURE_RESOURCE_NAME environment variable
    if (localAi.provider === "azure" && activeTab === "ai") {
      let alreadySet = false;
      try {
        await invoke<string>("get_env_var", { name: "AZURE_RESOURCE_NAME" });
        alreadySet = true;
      } catch {
        // Not set
      }

      const yes = alreadySet
        ? await ask(t("azureEnvAlreadySet"), { kind: "warning" })
        : await ask(t("azureEnvConfirm"), { kind: "info" });

      if (yes) {
        const value = window.prompt(t("azureEnvPrompt"), localAi.azureResourceName ?? "");
        if (value) {
          await invoke("set_env_var", { name: "AZURE_RESOURCE_NAME", value });
          await message(t("azureEnvSet"), { kind: "info" });
        }
      }
    }
  };

  const handleCancel = () => {
    setShowSettings(false);
  };

  // --- AI handlers ---
  const buildAzureBaseUrl = (resourceName: string, model: string) =>
    resourceName
      ? `https://${resourceName}.openai.azure.com/openai/deployments/${model}`
      : "";

  const selectProvider = useCallback((id: string) => {
    const p = PROVIDERS.find((x) => x.id === id);
    if (!p) return;
    const next: AiSettings = {
      ...localAi,
      provider: p.id,
      apiFormat: p.format,
      baseUrl: p.id === "azure"
        ? buildAzureBaseUrl(localAi.azureResourceName ?? "", p.model)
        : p.baseUrl,
      model: p.model,
      azureApiVersion: p.id === "azure" ? (localAi.azureApiVersion || "2025-01-01-preview") : localAi.azureApiVersion,
    };
    setLocalAi(next);
    setTestMsg(null);
    setManualModelInput(false);
  }, [localAi]);

  const updateAi = useCallback((patch: Partial<AiSettings>) => {
    const merged = { ...localAi, ...patch };
    if (merged.provider === "azure") {
      merged.baseUrl = buildAzureBaseUrl(merged.azureResourceName ?? "", merged.model);
    }
    setLocalAi(merged);
    setTestMsg(null);
  }, [localAi]);

  const handleTest = useCallback(async () => {
    if (!localAi.baseUrl || !localAi.model) return;
    setTesting(true);
    setTestMsg(null);
    try {
      await invoke("ai_test_connection", {
        req: {
          baseUrl: localAi.baseUrl,
          apiKey: localAi.apiKey,
          model: localAi.model,
          apiFormat: localAi.apiFormat,
          azureApiVersion: localAi.azureApiVersion ?? "",
        },
      });
      setTestMsg({ text: t("testSuccess"), ok: true });
      addVerifiedModel(localAi.provider, localAi.model);
    } catch (e) {
      setTestMsg({ text: String(e), ok: false });
    } finally {
      setTesting(false);
    }
  }, [localAi, t]);


  // --- Display handlers ---
  const handleVisibilityChange = (key: keyof typeof localVisibility, value: boolean) => {
    setLocalVisibility((prev) => ({ ...prev, [key]: value }));
  };

  if (!showSettings) return null;

  return (
    <div className="settings-overlay">
      <div className="settings-dialog">
        <div className="settings-dialog__header">
          <h2 className="settings-dialog__title">{t("title")}</h2>
        </div>

        <div className="settings-dialog__tabs">
          <button
            className={`settings-dialog__tab ${activeTab === "general" ? "settings-dialog__tab--active" : ""}`}
            onClick={() => setActiveTab("general")}
          >
            {t("tabGeneral")}
          </button>
          <button
            className={`settings-dialog__tab ${activeTab === "ai" ? "settings-dialog__tab--active" : ""}`}
            onClick={() => setActiveTab("ai")}
          >
            {t("tabAi")}
          </button>
          <button
            className={`settings-dialog__tab ${activeTab === "display" ? "settings-dialog__tab--active" : ""}`}
            onClick={() => setActiveTab("display")}
          >
            {t("tabDisplay")}
          </button>
          <button
            className={`settings-dialog__tab ${activeTab === "other" ? "settings-dialog__tab--active" : ""}`}
            onClick={() => setActiveTab("other")}
          >
            {t("tabOther")}
          </button>
        </div>

        <div className="settings-dialog__body">
          {activeTab === "general" && (
            <>
              <LanguageSelector />
              <div className="settings-dialog__divider" />
              <ThemeSelector />
              <div className="settings-dialog__divider" />
              <div className="settings-dialog__toggle-group">
                <label className="settings-dialog__toggle">
                  <span>{t("autoSave")}</span>
                  <input
                    type="checkbox"
                    checked={localAutoSave}
                    onChange={(e) => setLocalAutoSave(e.target.checked)}
                  />
                </label>
                <span className="settings-dialog__description">
                  {t("autoSaveDescription")}
                </span>
              </div>
              <div className="settings-dialog__divider" />
              <div className="settings-dialog__toggle-group">
                <label className="settings-dialog__toggle">
                  <span>{t("restoreLastFolders")}</span>
                  <input
                    type="checkbox"
                    checked={localRestoreLastFolders}
                    onChange={(e) => setLocalRestoreLastFolders(e.target.checked)}
                  />
                </label>
                <span className="settings-dialog__description">
                  {t("restoreLastFoldersDescription")}
                </span>
              </div>
              <div className="settings-dialog__divider" />
              <div className="settings-dialog__toggle-group">
                <label className="settings-dialog__toggle">
                  <span>{t("speechInput")}</span>
                  <input
                    type="checkbox"
                    checked={localSpeechEnabled}
                    onChange={(e) => setLocalSpeechEnabled(e.target.checked)}
                  />
                </label>
                <span className="settings-dialog__description">
                  {t("speechInputDescription")}
                </span>
              </div>
              {localSpeechEnabled && (
                <>
                  <div className="settings-dialog__field">
                    <label className="settings-dialog__label">{t("speechModel")}</label>
                    <select
                      className="settings-dialog__select"
                      value={localSpeechModel}
                      onChange={(e) => setLocalSpeechModel(e.target.value as SpeechModel)}
                      disabled={speechDownloading}
                    >
                      <option value="Xenova/whisper-small">whisper-small (~460MB)</option>
                      <option value="onnx-community/whisper-large-v3-turbo">whisper-large-v3-turbo (~1.6GB)</option>
                      {language === "en" && (
                        <option value="onnx-community/moonshine-base-ONNX">moonshine-base (~200MB)</option>
                      )}
                    </select>
                  </div>
                  <div className="settings-dialog__speech-status">
                    {speechModelReady[localSpeechModel] ? (
                      <span className="settings-dialog__speech-ready">
                        ✓ {t("speechModelReady")}
                      </span>
                    ) : speechDownloading ? (
                      <div className="settings-dialog__speech-progress">
                        <span>{t("speechModelDownloading")} {speechDownloadProgress}%</span>
                        <div className="settings-dialog__progress-bar">
                          <div
                            className="settings-dialog__progress-fill"
                            style={{ width: `${speechDownloadProgress}%` }}
                          />
                        </div>
                      </div>
                    ) : (
                      <button
                        className="settings-dialog__test-btn"
                        onClick={handleSpeechDownload}
                      >
                        {t("speechModelDownload")}
                      </button>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          {activeTab === "ai" && (
            <>
              <div className="settings-dialog__field">
                <label className="settings-dialog__label">{t("aiProvider")}</label>
                <select
                  className="settings-dialog__select"
                  value={localAi.provider}
                  onChange={(e) => selectProvider(e.target.value)}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </div>


              <div className="settings-dialog__field">
                <label className="settings-dialog__label">{t("aiApiKey")}</label>
                <input
                  className="settings-dialog__input"
                  type="password"
                  value={localAi.apiKey}
                  onChange={(e) => updateAi({ apiKey: e.target.value })}
                  placeholder="sk-..."
                />
                <span className="settings-dialog__sync-hint">
                  {localAi.provider === "custom" || localAi.provider === "ollama"
                    ? t("aiSyncToOpencodeNotSupported")
                    : t("aiSyncToOpencode")}
                </span>
              </div>

              {localAi.provider === "azure" && (
                <>
                  <div className="settings-dialog__field">
                    <label className="settings-dialog__label">{t("aiAzureResourceName")}</label>
                    <input
                      className="settings-dialog__input"
                      type="text"
                      value={localAi.azureResourceName ?? ""}
                      onChange={(e) => updateAi({ azureResourceName: e.target.value })}
                      placeholder={t("aiAzureResourceNamePlaceholder")}
                    />
                  </div>
                  <div className="settings-dialog__field">
                    <label className="settings-dialog__label">{t("aiAzureApiVersion")}</label>
                    <input
                      className="settings-dialog__input"
                      type="text"
                      value={localAi.azureApiVersion ?? "2025-01-01-preview"}
                      onChange={(e) => updateAi({ azureApiVersion: e.target.value })}
                      placeholder="2025-01-01-preview"
                    />
                  </div>
                </>
              )}

              {localAi.provider === "custom" && (
                <div className="settings-dialog__field">
                  <label className="settings-dialog__label">{t("aiEndpoint")}</label>
                  <input
                    className="settings-dialog__input"
                    type="text"
                    value={localAi.baseUrl}
                    onChange={(e) => updateAi({ baseUrl: e.target.value })}
                    placeholder="https://api.example.com/v1"
                  />
                </div>
              )}

              <div className="settings-dialog__field">
                <label className="settings-dialog__label">{t("aiModel")}</label>
                {manualModelInput || localAi.provider === "custom" ? (
                  <input
                    className="settings-dialog__input"
                    type="text"
                    value={localAi.model}
                    onChange={(e) => updateAi({ model: e.target.value })}
                    placeholder="model-name"
                  />
                ) : (
                  <select
                    className="settings-dialog__select"
                    value={modelOptions.includes(localAi.model) ? localAi.model : "__manual__"}
                    onChange={(e) => {
                      if (e.target.value === "__manual__") {
                        setManualModelInput(true);
                      } else {
                        updateAi({ model: e.target.value });
                      }
                    }}
                  >
                    {modelOptions.map((m) => {
                      const verified = (localAi.verifiedModels?.[localAi.provider] ?? []).includes(m);
                      return (
                        <option key={m} value={m}>
                          {m}{verified ? ` ${t("aiModelVerified")}` : ""}
                        </option>
                      );
                    })}
                    <option value="__manual__">{t("aiModelManualInput")}</option>
                  </select>
                )}
              </div>

              <div className="settings-dialog__test-row">
                <button
                  className="settings-dialog__test-btn"
                  onClick={handleTest}
                  disabled={testing || !localAi.baseUrl || !localAi.model}
                >
                  {testing ? t("testTesting") : t("testConnection")}
                </button>
                {testMsg && (
                  <span className={`settings-dialog__test-msg ${testMsg.ok ? "settings-dialog__test-msg--ok" : "settings-dialog__test-msg--err"}`}>
                    {testMsg.text}
                  </span>
                )}
              </div>
            </>
          )}

          {activeTab === "display" && (
            <>
              <div className="settings-dialog__section-title">{t("displayImages")}</div>
              <div className="settings-dialog__toggle-group">
                <label className="settings-dialog__toggle">
                  <span>{t("showImagesBtn")}</span>
                  <input
                    type="checkbox"
                    checked={localVisibility.showImages}
                    onChange={(e) => handleVisibilityChange("showImages", e.target.checked)}
                  />
                </label>
              </div>

              <div className="settings-dialog__divider" />

              <div className="settings-dialog__section-title">{t("displayOffice")}</div>
              <div className="settings-dialog__toggle-group">
                <label className="settings-dialog__toggle">
                  <span>{t("showDocxBtn")}</span>
                  <input
                    type="checkbox"
                    checked={localVisibility.showDocx}
                    onChange={(e) => handleVisibilityChange("showDocx", e.target.checked)}
                  />
                </label>
              </div>
              <div className="settings-dialog__toggle-group">
                <label className="settings-dialog__toggle">
                  <span>{t("showXlsBtn")}</span>
                  <input
                    type="checkbox"
                    checked={localVisibility.showXls}
                    onChange={(e) => handleVisibilityChange("showXls", e.target.checked)}
                  />
                </label>
              </div>

              <div className="settings-dialog__divider" />

              <div className="settings-dialog__section-title">PDF</div>
              <div className="settings-dialog__toggle-group">
                <label className="settings-dialog__toggle">
                  <span>{t("showPdfBtn")}</span>
                  <input
                    type="checkbox"
                    checked={localVisibility.showPdf}
                    onChange={(e) => handleVisibilityChange("showPdf", e.target.checked)}
                  />
                </label>
              </div>

              <div className="settings-dialog__divider" />

              <div className="settings-dialog__section-title">{t("displayMindmap")}</div>
              <div className="settings-dialog__toggle-group">
                <label className="settings-dialog__toggle">
                  <span>{t("showKmBtn")}</span>
                  <input
                    type="checkbox"
                    checked={localVisibility.showKm}
                    onChange={(e) => handleVisibilityChange("showKm", e.target.checked)}
                  />
                </label>
              </div>

            </>
          )}

          {activeTab === "other" && (
            <>
              <div className="settings-dialog__section-title">Zenn</div>
              <span className="settings-dialog__description">
                {t("zennInitDescription")}
              </span>
              <button
                className="settings-dialog__test-btn"
                onClick={handleZennInit}
              >
                {t("zennInit")}
              </button>
              <div className="settings-dialog__divider" />
              <div className="settings-dialog__section-title">
                {t("mediumSection")}
              </div>
              <div className="settings-dialog__field">
                <label className="settings-dialog__label">
                  {t("mediumApiToken")}
                </label>
                <input
                  type="password"
                  className="settings-dialog__input"
                  value={localMedium.apiToken}
                  onChange={(e) =>
                    setLocalMedium({ ...localMedium, apiToken: e.target.value })
                  }
                />
              </div>
              <div className="settings-dialog__test-row">
                <button
                  className="settings-dialog__test-btn"
                  onClick={handleMediumTest}
                  disabled={!localMedium.apiToken || mediumTestStatus === "testing"}
                >
                  {mediumTestStatus === "testing"
                    ? t("mediumTestTesting")
                    : t("mediumTestConnection")}
                </button>
                {mediumTestStatus !== "idle" && mediumTestStatus !== "testing" && (
                  <span className={`settings-dialog__test-msg ${mediumTestStatus === "success" ? "settings-dialog__test-msg--ok" : "settings-dialog__test-msg--err"}`}>
                    {mediumTestStatus === "success"
                      ? t("mediumConnectionSuccess", { username: mediumUsername })
                      : t("mediumConnectionFailed")}
                  </span>
                )}
              </div>
            </>
          )}

        </div>

        <div className="settings-dialog__footer">
          <button className="settings-dialog__cancel-btn" onClick={handleCancel}>
            {t("cancel")}
          </button>
          <button className="settings-dialog__save-btn" onClick={handleSave}>
            {t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}
