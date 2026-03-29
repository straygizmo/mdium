import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import jaCommon from "./locales/ja/common.json";
import jaEditor from "./locales/ja/editor.json";
import jaToolbar from "./locales/ja/toolbar.json";
import jaFileTree from "./locales/ja/file-tree.json";
import jaSettings from "./locales/ja/settings.json";
import jaOpencodeConfig from "./locales/ja/opencode-config.json";
import jaImageEditor from "./locales/ja/image-editor.json";

import enCommon from "./locales/en/common.json";
import enEditor from "./locales/en/editor.json";
import enToolbar from "./locales/en/toolbar.json";
import enFileTree from "./locales/en/file-tree.json";
import enSettings from "./locales/en/settings.json";
import enOpencodeConfig from "./locales/en/opencode-config.json";
import enImageEditor from "./locales/en/image-editor.json";

import jaGit from "./locales/ja/git.json";
import enGit from "./locales/en/git.json";

import jaVideo from "./locales/ja/video.json";
import enVideo from "./locales/en/video.json";

const savedLanguage = localStorage.getItem("mdium-lang") ?? "ja";

i18n.use(initReactI18next).init({
  resources: {
    ja: {
      common: jaCommon,
      editor: jaEditor,
      toolbar: jaToolbar,
      fileTree: jaFileTree,
      settings: jaSettings,
      "opencode-config": jaOpencodeConfig,
      imageEditor: jaImageEditor,
      git: jaGit,
      video: jaVideo,
    },
    en: {
      common: enCommon,
      editor: enEditor,
      toolbar: enToolbar,
      fileTree: enFileTree,
      settings: enSettings,
      "opencode-config": enOpencodeConfig,
      imageEditor: enImageEditor,
      git: enGit,
      video: enVideo,
    },
  },
  lng: savedLanguage,
  fallbackLng: "ja",
  defaultNS: "common",
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
