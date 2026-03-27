import { invoke } from "@tauri-apps/api/core";
import type { ThemePreset } from "./types";

/**
 * Map from theme ID (oc-xxx-dark/light) to opencode's built-in theme name.
 */
const OC_THEME_NAME_MAP: Record<string, string> = {
  "oc-opencode-dark": "opencode",
  "oc-opencode-light": "opencode",
  "oc-catppuccin-dark": "catppuccin",
  "oc-catppuccin-light": "catppuccin",
  "oc-catppuccin-frappe": "catppuccin-frappe",
  "oc-catppuccin-macchiato": "catppuccin-macchiato",
  "oc-dracula-dark": "dracula",
  "oc-dracula-light": "dracula",
  "oc-github-dark": "github",
  "oc-github-light": "github",
  "oc-nord-dark": "nord",
  "oc-nord-light": "nord",
  "oc-one-dark-dark": "one-dark",
  "oc-one-dark-light": "one-dark",
  "oc-tokyonight-dark": "tokyonight",
  "oc-tokyonight-light": "tokyonight",
  "oc-solarized-dark": "solarized",
  "oc-solarized-light": "solarized",
  "oc-gruvbox-dark": "gruvbox",
  "oc-gruvbox-light": "gruvbox",
  "oc-rosepine-dark": "rosepine",
  "oc-rosepine-light": "rosepine",
  "oc-monokai-dark": "monokai",
  "oc-monokai-light": "monokai",
  "oc-aura": "aura",
  "oc-ayu": "ayu",
  "oc-carbonfox-dark": "carbonfox",
  "oc-carbonfox-light": "carbonfox",
  "oc-cobalt2-dark": "cobalt2",
  "oc-cobalt2-light": "cobalt2",
  "oc-cursor-dark": "cursor",
  "oc-cursor-light": "cursor",
  "oc-everforest-dark": "everforest",
  "oc-everforest-light": "everforest",
  "oc-flexoki-dark": "flexoki",
  "oc-flexoki-light": "flexoki",
  "oc-kanagawa-dark": "kanagawa",
  "oc-kanagawa-light": "kanagawa",
  "oc-lucent-orng-dark": "lucent-orng",
  "oc-lucent-orng-light": "lucent-orng",
  "oc-material-dark": "material",
  "oc-material-light": "material",
  "oc-matrix-dark": "matrix",
  "oc-matrix-light": "matrix",
  "oc-mercury-dark": "mercury",
  "oc-mercury-light": "mercury",
  "oc-nightowl": "nightowl",
  "oc-orng-dark": "orng",
  "oc-orng-light": "orng",
  "oc-osaka-jade-dark": "osaka-jade",
  "oc-osaka-jade-light": "osaka-jade",
  "oc-palenight-dark": "palenight",
  "oc-palenight-light": "palenight",
  "oc-synthwave84-dark": "synthwave84",
  "oc-synthwave84-light": "synthwave84",
  "oc-vercel-dark": "vercel",
  "oc-vercel-light": "vercel",
  "oc-vesper-dark": "vesper",
  "oc-vesper-light": "vesper",
  "oc-zenburn-dark": "zenburn",
  "oc-zenburn-light": "zenburn",
};

async function getConfigDir(): Promise<string> {
  const home = await invoke<string>("get_home_dir");
  const sep = home.includes("\\") ? "\\" : "/";
  return `${home}${sep}.config${sep}opencode`;
}

async function writeTuiConfig(
  configDir: string,
  themeName: string,
): Promise<void> {
  const sep = configDir.includes("\\") ? "\\" : "/";
  const tuiPath = `${configDir}${sep}tui.json`;
  try {
    const existing = await invoke<string>("read_text_file", { path: tuiPath });
    const config = JSON.parse(existing);
    if (config.theme === themeName) return;
    config.theme = themeName;
    await invoke("write_text_file", {
      path: tuiPath,
      content: JSON.stringify(config, null, 2),
    });
  } catch {
    const config = {
      $schema: "https://opencode.ai/tui.json",
      theme: themeName,
    };
    await invoke("write_text_file_with_dirs", {
      path: tuiPath,
      content: JSON.stringify(config, null, 2),
    });
  }
}

export async function syncOpencodeTheme(preset: ThemePreset): Promise<void> {
  try {
    const configDir = await getConfigDir();
    const ocThemeName = OC_THEME_NAME_MAP[preset.id] ?? "opencode";
    await writeTuiConfig(configDir, ocThemeName);
  } catch {
    // Silently ignore
  }
}
