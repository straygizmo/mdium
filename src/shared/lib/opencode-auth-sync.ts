import { invoke } from "@tauri-apps/api/core";
import type { AiSettings } from "@/shared/types";

const PROVIDER_MAP: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  gemini: "google",
  groq: "groq",
  grok: "xai",
  deepseek: "deepseek",
  azure: "azure",
};

async function getHomeSep(): Promise<{ home: string; sep: string; isWin: boolean }> {
  const home = await invoke<string>("get_home_dir");
  const isWin = home.includes("\\");
  return { home, sep: isWin ? "\\" : "/", isWin };
}

async function getAuthJsonPath(): Promise<string> {
  const { home, sep, isWin } = await getHomeSep();
  if (isWin) {
    const appData = `${home}${sep}AppData${sep}Local${sep}opencode`;
    return `${appData}${sep}auth.json`;
  }
  return `${home}${sep}.local${sep}share${sep}opencode${sep}auth.json`;
}

async function getConfigJsonPath(): Promise<string> {
  const { home, sep } = await getHomeSep();
  return `${home}${sep}.config${sep}opencode${sep}config.json`;
}

async function syncModelToOpencode(opencodeProvider: string, model: string): Promise<void> {
  const configPath = await getConfigJsonPath();

  let configData: Record<string, unknown> = {};
  try {
    const raw = await invoke<string>("read_text_file", { path: configPath });
    configData = JSON.parse(raw);
  } catch {
    // file doesn't exist yet
  }

  configData.model = `${opencodeProvider}/${model}`;

  await invoke("write_text_file_with_dirs", {
    path: configPath,
    content: JSON.stringify(configData, null, 2),
  });
}

export async function syncProviderToOpencode(aiSettings: AiSettings): Promise<void> {
  const opencodeProvider = PROVIDER_MAP[aiSettings.provider];
  if (!opencodeProvider || !aiSettings.apiKey) return;

  const authPath = await getAuthJsonPath();

  let authData: Record<string, unknown> = {};
  try {
    const raw = await invoke<string>("read_text_file", { path: authPath });
    authData = JSON.parse(raw);
  } catch {
    // file doesn't exist yet
  }

  authData[opencodeProvider] = { type: "api", key: aiSettings.apiKey };

  await invoke("write_text_file_with_dirs", {
    path: authPath,
    content: JSON.stringify(authData, null, 2),
  });

  // Sync model to config.json
  if (aiSettings.model) {
    await syncModelToOpencode(opencodeProvider, aiSettings.model);
  }
}
