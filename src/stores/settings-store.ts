import { create } from "zustand";
import { persist } from "zustand/middleware";
import i18n from "@/shared/i18n";
import { applyTheme } from "@/shared/themes/apply-theme";
import { getThemeById, DEFAULT_THEME_ID } from "@/shared/themes";
import { syncOpencodeTheme } from "@/shared/themes/opencode-theme-sync";
import { syncProviderToOpencode } from "@/shared/lib/opencode-auth-sync";
import type { AiSettings, RagSettings } from "@/shared/types";

export type Language = "ja" | "en";

const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: "deepseek",
  apiKey: "",
  model: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
  apiFormat: "openai",
  verifiedModels: {},
};

const DEFAULT_RAG_SETTINGS: RagSettings = {
  embeddingModel: "Xenova/multilingual-e5-base",
  minChunkLength: 0,
  fileExtensions: ".md",
  retrieveTopK: 5,
  retrieveMinScore: 0.1,
};

export type SpeechModel = "Xenova/whisper-small" | "onnx-community/whisper-large-v3-turbo" | "onnx-community/moonshine-base-ONNX";

interface SettingsState {
  themeId: string;
  language: Language;
  autoSave: boolean;
  scrollSync: boolean;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  showSettings: boolean;
  aiSettings: AiSettings;
  ragSettings: RagSettings;
  speechEnabled: boolean;
  speechModel: SpeechModel;

  setThemeId: (id: string) => void;
  setLanguage: (lang: Language) => void;
  setAutoSave: (enabled: boolean) => void;
  setScrollSync: (enabled: boolean) => void;
  setFontFamily: (font: string) => void;
  setFontSize: (size: number) => void;
  setLineHeight: (height: number) => void;
  setShowSettings: (show: boolean) => void;
  setAiSettings: (settings: AiSettings) => void;
  addVerifiedModel: (provider: string, model: string) => void;
  setRagSettings: (settings: RagSettings) => void;
  setSpeechEnabled: (enabled: boolean) => void;
  setSpeechModel: (model: SpeechModel) => void;
  initializeTheme: () => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      themeId: DEFAULT_THEME_ID,
      language: "ja",
      autoSave: false,
      scrollSync: true,
      fontFamily: '"Segoe UI", "Meiryo", sans-serif',
      fontSize: 14,
      lineHeight: 1.6,
      showSettings: false,
      aiSettings: DEFAULT_AI_SETTINGS,
      ragSettings: DEFAULT_RAG_SETTINGS,
      speechEnabled: false,
      speechModel: "Xenova/whisper-small" as SpeechModel,

      setThemeId: (id) => {
        const theme = getThemeById(id);
        applyTheme(theme);
        set({ themeId: id });
        syncOpencodeTheme(theme);
      },

      setLanguage: (lang) => {
        i18n.changeLanguage(lang);
        localStorage.setItem("mdium-lang", lang);
        set({ language: lang });
      },

      setAutoSave: (enabled) => set({ autoSave: enabled }),
      setScrollSync: (enabled) => set({ scrollSync: enabled }),
      setFontFamily: (font) => set({ fontFamily: font }),
      setFontSize: (size) => set({ fontSize: size }),
      setLineHeight: (height) => set({ lineHeight: height }),
      setShowSettings: (show) => set({ showSettings: show }),
      setAiSettings: (settings) => {
        set({ aiSettings: settings });
        syncProviderToOpencode(settings).catch(() => {});
      },
      addVerifiedModel: (provider, model) => {
        const ai = get().aiSettings;
        const prev = ai.verifiedModels ?? {};
        const list = prev[provider] ?? [];
        if (list.includes(model)) return;
        const next: AiSettings = {
          ...ai,
          verifiedModels: { ...prev, [provider]: [...list, model] },
        };
        set({ aiSettings: next });
      },
      setRagSettings: (settings) => set({ ragSettings: settings }),
      setSpeechEnabled: (enabled) => set({ speechEnabled: enabled }),
      setSpeechModel: (model) => set({ speechModel: model }),

      initializeTheme: () => {
        const theme = getThemeById(get().themeId);
        applyTheme(theme);
        i18n.changeLanguage(get().language);
        syncOpencodeTheme(theme);
      },
    }),
    {
      name: "mdium-settings",
      partialize: (state) => ({
        themeId: state.themeId,
        language: state.language,
        autoSave: state.autoSave,
        scrollSync: state.scrollSync,
        fontFamily: state.fontFamily,
        fontSize: state.fontSize,
        lineHeight: state.lineHeight,
        aiSettings: state.aiSettings,
        ragSettings: state.ragSettings,
        speechEnabled: state.speechEnabled,
        speechModel: state.speechModel,
      }),
    }
  )
);
