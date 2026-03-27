#!/usr/bin/env node
/**
 * Import opencode built-in themes and generate ThemePreset .ts files.
 * Usage: node scripts/import-opencode-themes.mjs
 */

import { execSync } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";

const THEMES_DIR = join(
  import.meta.dirname,
  "../src/shared/themes/presets"
);
const REPO = "sst/opencode";
const THEME_PATH =
  "packages/opencode/src/cli/cmd/tui/context/theme";

// Themes to import (all opencode built-in TUI themes)
const THEME_NAMES = [
  "opencode",
  "catppuccin",
  "catppuccin-frappe",
  "catppuccin-macchiato",
  "dracula",
  "github",
  "nord",
  "one-dark",
  "tokyonight",
  "solarized",
  "gruvbox",
  "rosepine",
  "monokai",
  "aura",
  "ayu",
  "carbonfox",
  "cobalt2",
  "cursor",
  "everforest",
  "flexoki",
  "kanagawa",
  "lucent-orng",
  "material",
  "matrix",
  "mercury",
  "nightowl",
  "orng",
  "osaka-jade",
  "palenight",
  "synthwave84",
  "vercel",
  "vesper",
  "zenburn",
];

function fetchThemeJson(name) {
  const raw = execSync(
    `gh api repos/${REPO}/contents/${THEME_PATH}/${name}.json`,
    { encoding: "utf-8" }
  ).trim();
  const data = JSON.parse(raw);
  return JSON.parse(Buffer.from(data.content, "base64").toString("utf-8"));
}

function resolveColor(value, defs) {
  if (!value) return value;
  if (typeof value === "string") {
    // If it starts with #, it's a direct color
    if (value.startsWith("#")) return value;
    // Otherwise it's a defs reference
    return defs[value] || value;
  }
  return value;
}

function resolveTheme(json, mode) {
  const defs = json.defs || {};
  const theme = json.theme || {};
  const resolved = {};
  for (const [key, val] of Object.entries(theme)) {
    if (typeof val === "string") {
      resolved[key] = resolveColor(val, defs);
    } else if (typeof val === "object" && val !== null) {
      resolved[key] = resolveColor(val[mode], defs);
    }
  }
  return resolved;
}

function hasDarkLightVariants(json) {
  const theme = json.theme || {};
  for (const val of Object.values(theme)) {
    if (typeof val === "object" && val !== null && val.dark && val.light) {
      // Check if dark and light are actually different
      const defs = json.defs || {};
      const dark = resolveColor(val.dark, defs);
      const light = resolveColor(val.light, defs);
      if (dark !== light) return true;
    }
  }
  return false;
}

function adjustAlpha(hex, alpha) {
  return `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${alpha})`;
}

function lighten(hex, amount) {
  const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + amount);
  const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + amount);
  const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + amount);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function darken(hex, amount) {
  const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - amount);
  const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - amount);
  const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - amount);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function opencodeToThemePreset(resolved, id, name, type) {
  const isDark = type === "dark";
  const bg = resolved.background || "#1e1e2e";
  const bgPanel = resolved.backgroundPanel || (isDark ? darken(bg, 10) : lighten(bg, 10));
  const bgElement = resolved.backgroundElement || (isDark ? lighten(bg, 20) : darken(bg, 20));
  const border = resolved.border || (isDark ? lighten(bg, 40) : darken(bg, 40));
  const primary = resolved.primary || "#7aa2f7";
  const text = resolved.text || (isDark ? "#e6edf3" : "#1f2937");

  return {
    id,
    name,
    type,
    colors: {
      primary: primary,
      primaryHover: resolved.secondary || lighten(primary, 20),
      secondary: resolved.secondary || primary,
      bgBase: bg,
      bgSurface: bgPanel,
      bgOverlay: bgElement,
      bgInput: bgElement,
      border: border,
      borderHover: resolved.borderActive || primary,
      text: text,
      textSecondary: resolved.syntaxOperator || resolved.textMuted || (isDark ? "#a6adc8" : "#6b7280"),
      textMuted: resolved.textMuted || (isDark ? "#6c7086" : "#9ca3af"),
      accentBlue: resolved.accent || resolved.info || "#89b4fa",
      accentGreen: resolved.success || "#a6e3a1",
      accentRed: resolved.error || "#f38ba8",
      codeBg: isDark ? (bgElement || "#1e1e2e") : darken(bg, 200),
      codeText: resolved.markdownCode || text,
      inlineCodeBg: isDark ? bgElement : darken(bg, 15),
      inlineCodeText: resolved.markdownCode || primary,
      shadow: isDark ? "rgba(0, 0, 0, 0.3)" : "rgba(0, 0, 0, 0.08)",
      shadowStrong: isDark ? "rgba(0, 0, 0, 0.5)" : "rgba(0, 0, 0, 0.15)",
      toolbarText: primary,
      selection: border,
      cellSelected: bgElement,
      cellEditing: border,
    },
  };
}

function toVarName(id) {
  return id
    .replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
    .replace(/^([a-z])/, (_, c) => c.toLowerCase());
}

function toFileName(id) {
  return id; // already kebab-case
}

function generateThemeFile(preset) {
  const varName = toVarName(preset.id);
  const lines = [
    `import type { ThemePreset } from "../types";`,
    ``,
    `export const ${varName}: ThemePreset = ${JSON.stringify(preset, null, 2)};`,
    ``,
  ];
  return lines.join("\n");
}

function toDisplayName(themeName, mode) {
  const nameMap = {
    opencode: "OpenCode",
    catppuccin: "Catppuccin",
    "catppuccin-frappe": "Catppuccin Frappé",
    "catppuccin-macchiato": "Catppuccin Macchiato",
    dracula: "Dracula",
    github: "GitHub",
    nord: "Nord",
    "one-dark": "One Dark",
    tokyonight: "Tokyo Night",
    solarized: "Solarized",
    gruvbox: "Gruvbox",
    rosepine: "Rosé Pine",
    monokai: "Monokai",
    aura: "Aura",
    ayu: "Ayu",
    carbonfox: "Carbonfox",
    cobalt2: "Cobalt2",
    cursor: "Cursor",
    everforest: "Everforest",
    flexoki: "Flexoki",
    kanagawa: "Kanagawa",
    "lucent-orng": "Lucent Orng",
    material: "Material",
    matrix: "Matrix",
    mercury: "Mercury",
    nightowl: "Night Owl",
    orng: "Orng",
    "osaka-jade": "Osaka Jade",
    palenight: "Palenight",
    synthwave84: "Synthwave '84",
    vercel: "Vercel",
    vesper: "Vesper",
    zenburn: "Zenburn",
  };
  const base = nameMap[themeName] || themeName;
  if (mode) {
    return `${base} ${mode === "dark" ? "Dark" : "Light"}`;
  }
  return base;
}

// Main
const allPresets = [];

for (const themeName of THEME_NAMES) {
  console.log(`Fetching ${themeName}...`);
  let json;
  try {
    json = fetchThemeJson(themeName);
  } catch (e) {
    console.error(`  Failed to fetch ${themeName}: ${e.message}`);
    continue;
  }

  const hasVariants = hasDarkLightVariants(json);

  if (hasVariants) {
    // Generate both dark and light presets
    for (const mode of ["dark", "light"]) {
      const resolved = resolveTheme(json, mode);
      const id = `oc-${themeName}-${mode}`;
      const displayName = toDisplayName(themeName, mode);
      const preset = opencodeToThemePreset(resolved, id, displayName, mode);
      const fileName = toFileName(id);
      const content = generateThemeFile(preset);
      writeFileSync(join(THEMES_DIR, `${fileName}.ts`), content);
      allPresets.push({ id, fileName, varName: toVarName(id) });
      console.log(`  Generated ${fileName}.ts (${mode})`);
    }
  } else {
    // Dark-only theme
    const resolved = resolveTheme(json, "dark");
    const id = `oc-${themeName}`;
    const displayName = toDisplayName(themeName);
    const preset = opencodeToThemePreset(resolved, id, displayName, "dark");
    const fileName = toFileName(id);
    const content = generateThemeFile(preset);
    writeFileSync(join(THEMES_DIR, `${fileName}.ts`), content);
    allPresets.push({ id, fileName, varName: toVarName(id) });
    console.log(`  Generated ${fileName}.ts`);
  }
}

// Generate index exports
console.log("\nGenerating presets/index.ts...");
const ocExports = allPresets.map(
  (p) => `export { ${p.varName} } from "./${p.fileName}";`
);
const indexContent = [...ocExports, ""].join("\n");
writeFileSync(join(THEMES_DIR, "index.ts"), indexContent);

// Generate theme registry snippet
console.log("\nPresets to register in themes/index.ts:");
console.log("imports:");
for (const p of allPresets) {
  console.log(`  ${p.varName},`);
}
console.log("\narray:");
for (const p of allPresets) {
  console.log(`  ${p.varName},`);
}

console.log(`\nDone! Generated ${allPresets.length} theme presets.`);

// Write a summary JSON for updating themes/index.ts
writeFileSync(
  join(import.meta.dirname, "opencode-themes-summary.json"),
  JSON.stringify(allPresets, null, 2)
);
