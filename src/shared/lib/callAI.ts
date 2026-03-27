import { invoke } from "@tauri-apps/api/core";
import type { AiSettings } from "@/shared/types";

/**
 * AI API を呼び出す汎用関数。
 * Tauri バックエンド経由で API を呼び出す（CORS 回避）。
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
