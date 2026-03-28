import { invoke } from "@tauri-apps/api/core";
import type { AiSettings } from "@/shared/types";

/**
 * Generic function to call AI API.
 * Calls API via Tauri backend (to avoid CORS).
 */
export async function callAI(
  settings: AiSettings,
  systemPrompt: string,
  userContent: string,
): Promise<string> {
  return invoke<string>("ai_chat", {
    req: {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      apiFormat: settings.apiFormat,
      azureApiVersion: settings.azureApiVersion ?? "",
      systemPrompt,
      userMessage: userContent,
    },
  });
}
