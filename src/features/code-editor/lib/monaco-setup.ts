// src/features/code-editor/lib/monaco-setup.ts

import * as monaco from "monaco-editor";
import loader from "@monaco-editor/loader";
import { registerCsvLanguages } from "./csv-language";

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });

registerCsvLanguages(monaco);

const CSV_COLORS_LIGHT = [
  "D73A49", "E36209", "B08800", "22863A", "005CC5",
  "6F42C1", "D03592", "795E26", "1F7A7A", "6E7781",
];
const CSV_COLORS_DARK = [
  "FF7B72", "FFA657", "D2A8FF", "7EE787", "79C0FF",
  "BC8CFF", "F778BA", "E3B341", "39C5CF", "8B949E",
];

monaco.editor.defineTheme("mdium-csv-light", {
  base: "vs",
  inherit: true,
  rules: CSV_COLORS_LIGHT.map((color, i) => ({
    token: `col${i}`,
    foreground: color,
  })),
  colors: {},
});

monaco.editor.defineTheme("mdium-csv-dark", {
  base: "vs-dark",
  inherit: true,
  rules: CSV_COLORS_DARK.map((color, i) => ({
    token: `col${i}`,
    foreground: color,
  })),
  colors: {},
});
